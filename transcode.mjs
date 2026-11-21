// csv-reader 1.0.0's answers, written straight from the bytes of cases.json to the bytes of answers.json.
//
// cases.json is JSON.stringify's text: each case's CSV text sits in it as a JSON string, its quotes written \", its
// line breaks \n and \r, its backslashes \\, other control characters \t \b \f or \u00XX, and every other character
// as its own UTF-8 bytes. An answer's fields are pieces of that text, so the JSON string of a field is, byte for byte,
// the piece of the escaped text it came from, with csv-reader's few rewrites made on the escapes themselves: a doubled
// quote \"\" inside quotes becomes \", a CR inside quotes (\r or \r\n) becomes \n, a stray CR outside them (\r) is
// dropped. The reader below is csv-reader's own reading (solve.js says it in full), done on that escaped text: every
// CSV-significant character is a backslash sequence or a comma, so a byte that is neither is copied as it stands.
//
// transcode(bytes) returns the answers file's bytes, or null when the file is not what this reader expects (a \u
// escape anywhere, a case whose input is not {text: string, header}, a shape it does not know): the caller then reads
// the file the ordinary way, with run().

const BS = 92; // backslash
const QU = 34; // quote
const CM = 44; // comma
const LN = 110; // 'n' after a backslash: LF
const LR = 114; // 'r' after a backslash: CR

let I = null; // the input bytes
let O = null; // the output bytes
let o = 0; // the next output byte
let line = 1; // the line the reader is on
let errs = []; // the current case's errors, each a JSON text
let recLine = 1; // the line the record being read starts on
let recRow = 'null'; // its row index as JSON (null: the header)
let fieldEnd = 0; // how the last field ended: 0 comma, 1 line break, 2 end of text
let added = 0; // characters an unquoted read kept
let BAD = false; // a text held an unescaped quote: its end was not where textEnd found it

function ensure(extra) {
  if (o + extra <= O.length) return;
  let size = O.length * 2;
  while (size < o + extra) size *= 2;
  const grown = Buffer.allocUnsafe(size);
  O.copy(grown, 0, 0, o);
  O = grown;
}

function put(s) {
  ensure(s.length);
  o += O.latin1Write(s, o);
}

function error(code) {
  errs.push('{"code":"' + code + '","line":' + recLine + ',"row":' + recRow + '}');
}

/** Reads unquoted escaped text from i up to a comma or line break, copying what it keeps; returns where it stopped. */
function unquoted(i, end) {
  const t = I;
  const out = O;
  let p = o;
  let kept = 0;
  for (;;) {
    if (i >= end) {
      fieldEnd = 2;
      break;
    }
    const b = t[i];
    if (b !== BS) {
      if (b === CM) {
        i += 1;
        fieldEnd = 0;
        break;
      }
      if (b === QU) BAD = true; // an unescaped quote: not one JSON string (see textEnd)
      out[p++] = b;
      kept += 1;
      i += 1;
      continue;
    }
    const c = t[i + 1];
    if (c === LN) {
      i += 2;
      line += 1;
      fieldEnd = 1;
      break;
    }
    if (c === LR) {
      if (t[i + 2] === BS && t[i + 3] === LN) {
        i += 4;
        line += 1;
        fieldEnd = 1;
        break;
      }
      error('stray_cr');
      i += 2;
      continue;
    }
    // \" (a quote, a plain character here), \\, \t, \b, \f, \/: one character, its escape kept.
    out[p++] = BS;
    out[p++] = c;
    kept += 1;
    i += 2;
  }
  o = p;
  added = kept;
  return i;
}

/** Reads a field that opens with the escaped quote at i; returns where it stopped. */
function quoted(i, end) {
  const t = I;
  const out = O;
  const open = i;
  const openLine = line;
  const start = o;
  let p = o;
  i += 2;
  for (;;) {
    if (i >= end) {
      // The quote never closes: a plain character, and the text after it is read again as unquoted.
      o = start;
      line = openLine;
      error('unterminated_quote');
      return unquoted(open, end);
    }
    const b = t[i];
    if (b !== BS) {
      if (b === QU) BAD = true; // an unescaped quote: not one JSON string (see textEnd)
      out[p++] = b;
      i += 1;
      continue;
    }
    const c = t[i + 1];
    if (c === QU) {
      if (t[i + 2] === BS && t[i + 3] === QU) {
        out[p++] = BS;
        out[p++] = QU;
        i += 4;
        continue;
      }
      i += 2;
      break;
    }
    if (c === LR) {
      out[p++] = BS;
      out[p++] = LN;
      line += 1;
      i += t[i + 2] === BS && t[i + 3] === LN ? 4 : 2;
      continue;
    }
    if (c === LN) line += 1;
    out[p++] = BS;
    out[p++] = c;
    i += 2;
  }
  o = p;
  if (i >= end) {
    fieldEnd = 2;
    return i;
  }
  const b = t[i];
  if (b === CM) {
    fieldEnd = 0;
    return i + 1;
  }
  if (b === BS) {
    const c = t[i + 1];
    if (c === LN) {
      line += 1;
      fieldEnd = 1;
      return i + 2;
    }
    if (c === LR && t[i + 2] === BS && t[i + 3] === LN) {
      line += 1;
      fieldEnd = 1;
      return i + 4;
    }
  }
  // What follows the closing quote is appended as it stands (quote_junk when anything is kept).
  i = unquoted(i, end);
  if (added > 0) error('quote_junk');
  return i;
}

/** Writes one case's answer for the escaped text I[ts, te) and its header flag. */
function answer(ts, te, header) {
  const t = I;
  ensure(3 * (te - ts) + 4096);
  errs = [];
  line = 1;
  let i = ts;
  // A BOM (U+FEFF, the bytes EF BB BF) at the very start is dropped.
  if (te - ts >= 3 && t[i] === 0xef && t[i + 1] === 0xbb && t[i + 2] === 0xbf) i += 3;
  let needHeader = header;
  let width = -1;
  let rows = 0;
  put(header ? '{"columns":' : '{"columns":null,"rows":[');
  for (;;) {
    // Lines with no characters (LF or CRLF alone) are no records.
    while (i < te && t[i] === BS) {
      if (t[i + 1] === LN) {
        i += 2;
        line += 1;
      } else if (t[i + 1] === LR && t[i + 2] === BS && t[i + 3] === LN) {
        i += 4;
        line += 1;
      } else {
        break;
      }
    }
    if (i >= te) break;

    recLine = line;
    recRow = needHeader ? 'null' : String(rows);
    // Room for the rest of the text: every input byte makes at most 3 output bytes (a comma makes ","; a line break,
    // 2 bytes escaped, makes "],[" and the next quote), so no write below runs past the buffer; padding asks again.
    ensure(3 * (te - i) + 4096);
    const recStart = o;
    if (!needHeader && rows > 0) O[o++] = CM;
    O[o++] = 91; // [
    let count = 0;
    let cut = -1; // where the fields past the width start (the comma before the first)
    let lastQuoted = false;
    let lastStart = 0;
    for (;;) {
      if (count > 0) {
        if (count === width && cut < 0) cut = o;
        O[o++] = CM;
      }
      O[o++] = QU;
      lastStart = o;
      lastQuoted = i < te && t[i] === BS && t[i + 1] === QU;
      i = lastQuoted ? quoted(i, te) : unquoted(i, te);
      O[o++] = QU;
      count += 1;
      if (fieldEnd !== 0) break;
    }
    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (count === 1 && !lastQuoted && o === lastStart + 1) {
      o = recStart;
      continue;
    }
    if (width < 0) width = count;
    if (needHeader) {
      O[o++] = 93; // ]
      put(',"rows":[');
      needHeader = false;
      continue;
    }
    if (count < width) {
      errs.push('{"code":"short_row","line":' + recLine + ',"row":' + recRow + ',"fields":' + count + '}');
      ensure(3 * (width - count) + 1);
      for (let k = count; k < width; k++) {
        O[o++] = CM;
        O[o++] = QU;
        O[o++] = QU;
      }
    } else if (count > width) {
      const extra = O.latin1Slice(cut + 1, o);
      errs.push('{"code":"long_row","line":' + recLine + ',"row":' + recRow + ',"extra":[' + extra + ']}');
      o = cut;
    }
    O[o++] = 93; // ]
    rows += 1;
  }
  if (needHeader) put('[],"rows":[');
  put('],"errors":[');
  put(errs.join(','));
  put(']}');
}

// ---- The shape of cases.json: [{"id": ..., "input": {"text": "...", "header": ...}}, ...] ----

let J = 0; // the reading position in I
let JN = 0; // I's length

function ws() {
  while (J < JN) {
    const b = I[J];
    if (b === 32 || b === 10 || b === 13 || b === 9) J += 1;
    else break;
  }
}

/** Skips a JSON string at J (J at its opening quote); returns [start, end) of its raw content. */
function str() {
  if (I[J] !== QU) throw new Error('shape');
  const s = J + 1;
  let i = s;
  for (;;) {
    if (i >= JN) throw new Error('shape');
    const b = I[i];
    if (b === QU) break;
    i += b === BS ? 2 : 1;
  }
  J = i + 1;
  return s;
}

/** Where the JSON string whose content starts at s ends (its closing quote). JSON.stringify writes {text, header} in
 *  that order, so the end is found with one native search for the bytes that follow it, `","header":`, kept when the
 *  quote it starts with is not escaped (an even run of backslashes before it); otherwise the string is walked. */
function textEnd(s) {
  const m = I.indexOf(HEADER_NEXT, s);
  if (m >= 0) {
    let k = m - 1;
    while (k >= s && I[k] === BS) k -= 1;
    // An even run: the quote at m is unescaped. Were the string to end before m (a case with no header after its
    // text), [s, m) would hold an unescaped quote, which the readers see as they copy (BAD): the file is then read
    // the ordinary way.
    if ((m - 1 - k) % 2 === 0) return m;
  }
  J = s - 1;
  str();
  return J - 1;
}
const HEADER_NEXT = Buffer.from('","header":', 'latin1');

function skipValue() {
  ws();
  const b = I[J];
  if (b === QU) {
    str();
  } else if (b === 123 || b === 91) {
    const close = b === 123 ? 125 : 93;
    J += 1;
    ws();
    if (I[J] === close) {
      J += 1;
      return;
    }
    for (;;) {
      ws();
      if (b === 123) {
        str();
        ws();
        if (I[J] !== 58) throw new Error('shape');
        J += 1;
      }
      skipValue();
      ws();
      if (I[J] === 44) {
        J += 1;
        continue;
      }
      if (I[J] !== close) throw new Error('shape');
      J += 1;
      return;
    }
  } else {
    // A number or a literal: up to the next delimiter.
    while (J < JN) {
      const c = I[J];
      if (c === 44 || c === 125 || c === 93 || c === 32 || c === 10 || c === 13 || c === 9) break;
      J += 1;
    }
  }
}

/** The bytes I[s, e) as a key: true when they spell `name` exactly. */
function is(s, e, name) {
  if (e - s !== name.length) return false;
  for (let k = 0; k < name.length; k++) if (I[s + k] !== name.charCodeAt(k)) return false;
  return true;
}

/** Iterates an object's members at J: calls member(keyStart, keyEnd) with J at the value, which it must consume. */
function members(member) {
  ws();
  if (I[J] !== 123) throw new Error('shape');
  J += 1;
  ws();
  if (I[J] === 125) {
    J += 1;
    return;
  }
  for (;;) {
    ws();
    const ks = str();
    const ke = J - 1;
    ws();
    if (I[J] !== 58) throw new Error('shape');
    J += 1;
    ws();
    member(ks, ke);
    ws();
    if (I[J] === 44) {
      J += 1;
      continue;
    }
    if (I[J] !== 125) throw new Error('shape');
    J += 1;
    return;
  }
}

/** The cases' [textStart, textEnd, header] triples, or throws when the file is not of the shape read here. */
function shape() {
  const cases = [];
  J = 0;
  ws();
  if (I[J] !== 91) throw new Error('shape');
  J += 1;
  ws();
  if (I[J] === 93) return cases;
  for (;;) {
    let ts = -1;
    let te = -1;
    let header = false;
    let hasInput = false;
    members((ks, ke) => {
      if (!is(ks, ke, 'input')) return skipValue();
      hasInput = true;
      ts = -1;
      header = false;
      members((ks2, ke2) => {
        if (is(ks2, ke2, 'text')) {
          if (I[J] !== QU) throw new Error('shape');
          ts = J + 1;
          te = textEnd(ts);
          J = te + 1;
        } else if (is(ks2, ke2, 'header')) {
          const s = J;
          skipValue();
          header = J - s === 4 && is(s, J, 'true');
        } else {
          skipValue();
        }
      });
    });
    if (!hasInput || ts < 0) throw new Error('shape');
    cases.push(ts, te, header);
    ws();
    if (I[J] === 44) {
      J += 1;
      continue;
    }
    if (I[J] !== 93) throw new Error('shape');
    J += 1;
    ws();
    if (J !== JN) throw new Error('shape');
    return cases;
  }
}

/** answers.json's bytes for cases.json's bytes, or null to read it the ordinary way. */
export function transcode(bytes) {
  // Any \u escape (a control character, a lone surrogate, an escaped BOM...) is left to the ordinary reader.
  if (bytes.indexOf('\\u') >= 0) return null;
  I = bytes;
  JN = bytes.length;
  let cases;
  try {
    cases = shape();
  } catch {
    I = null;
    return null;
  }
  O = Buffer.allocUnsafe(Math.max(1 << 16, bytes.length + (bytes.length >> 2)));
  o = 0;
  BAD = false;
  put('[');
  for (let k = 0; k < cases.length; k += 3) {
    if (k > 0) put(',');
    answer(cases[k], cases[k + 1], cases[k + 2]);
  }
  put(']');
  const result = BAD ? null : O.subarray(0, o);
  I = null;
  O = null;
  errs = [];
  return result;
}

// Warm-up: a small file that takes every branch (quotes doubled, CR alone and before LF inside quotes and out, junk
// after a closing quote, a quote that never closes, short and long rows, blank lines, a BOM, escapes that are plain
// characters), read a few times at load so the optimised code has seen every path before the real file.
{
  const lines = [
    'a,b,c',
    'alpha,"bravo, charlie","say ""hi"""',
    '"multi\nline","cr\r\nlf","lone\rcr"',
    'short',
    'x,y,z,extra,more',
    'stray\rcr,"junk"kg,"ok"\r',
    '',
    '\r',
    '"q"!,"q"\r?,Zürich 東京',
    '1,mid"quote,back\\slash\ttab',
    '"n1\nn2\rn3\r\nn4",tail,"a\n\nb"',
    '"j"x"y,z,"j"\r\r',
    'a\r\rb,c\r,"e""""f"',
  ];
  const cases = [];
  for (const eol of ['\n', '\r\n']) {
    const s = lines.join(eol);
    cases.push({ id: 'w', input: { text: s, header: true } });
    cases.push({ id: 'w', input: { text: '\uFEFF' + s + eol + '"never,closed' + eol + 'p,q', header: false } });
    cases.push({ id: 'w', input: { text: '', header: true } });
  }
  const sample = Buffer.from(JSON.stringify(cases), 'utf8');
  for (let k = 0; k < 60; k++) transcode(sample);
}
