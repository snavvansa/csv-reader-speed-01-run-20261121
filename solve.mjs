// A faster drop-in for csv-reader 1.0.0's readCsv: the same {columns, rows, errors} for every {text, header}.
//
// The reading rules are csv-reader's own (see README.md); this file only reads them faster. csv-reader looks at one
// character at a time; here the text is cut by the engine's own string search:
//
//   - the next quote, LF, CR and comma at or after the read position are kept (QN, LN, CN, MN), each found again with
//     indexOf only once the position passes it, so each is searched for once over the whole text;
//   - an unquoted field ends at the first of the next comma, LF and CR: one slice of the text, with no look at its
//     characters (a quote inside it is a plain character);
//   - a quoted field jumps from quote to quote, counting the LFs it passes and turning each CR (alone or before LF)
//     into one LF;
//   - anything else (a stray CR, a quote inside an unquoted field, characters after a closing quote) is read by a
//     plain loop over its characters, as csv-reader reads it.
//
// The scanners share a few module-level registers (the text, the position, the line, the record being read), set at
// the start of each run() and cleared at its end: nothing outlives a call. The module runs run() a few times on a
// small text that takes every branch before the first real call, so the optimised code has seen every path.

const COMMA = 44;
const QUOTE = 34;
const LF = 10;
const CR = 13;

let T = ''; // the text
let N = 0; // its length
let P = 0; // the next character to read
let LINE = 1; // the line that character is on
let ERRORS = []; // the errors met so far
let REC_LINE = 1; // the line the record being read starts on
let REC_ROW = null; // its index in rows (null: the header)
let V = ''; // the field just read by quoted() or unquoted()
let MORE = false; // whether it ended at a comma (the record goes on)
let QN = -1; // the first quote at or after the position it was looked for from (N: none)
let LN = -1; // the same for LF
let CN = -1; // the same for CR
let MN = -1; // the same for a comma

function err(code) {
  ERRORS.push({ code, line: REC_LINE, row: REC_ROW });
}

function nextQuote(from) {
  const i = T.indexOf('"', from);
  return i < 0 ? N : i;
}
function nextLf(from) {
  const i = T.indexOf('\n', from);
  return i < 0 ? N : i;
}
function nextCr(from) {
  const i = T.indexOf('\r', from);
  return i < 0 ? N : i;
}
function nextComma(from) {
  const i = T.indexOf(',', from);
  return i < 0 ? N : i;
}

/** Unquoted characters from `start`, appended to `prefix`, up to the next comma or line break (stray CRs dropped). */
function unquoted(start, prefix, junk) {
  const t = T;
  const n = N;
  let value = prefix;
  let q = start;
  let seg = start;
  let added = 0;
  let more = false;
  for (;;) {
    if (q >= n) {
      P = q;
      break;
    }
    const d = t.charCodeAt(q);
    if (d > COMMA) {
      q += 1;
      continue;
    }
    if (d === COMMA) {
      more = true;
      P = q + 1;
      break;
    }
    if (d === LF) {
      P = q + 1;
      LINE += 1;
      break;
    }
    if (d === CR) {
      if (t.charCodeAt(q + 1) === LF) {
        P = q + 2;
        LINE += 1;
        break;
      }
      err('stray_cr');
      added += q - seg;
      value += t.slice(seg, q);
      q += 1;
      seg = q;
      continue;
    }
    q += 1;
  }
  added += q - seg;
  V = value === '' ? t.slice(seg, q) : value + t.slice(seg, q);
  MORE = more;
  if (junk && added > 0) err('quote_junk');
}

/** A field that opens with the quote at `open`. */
function quoted(open) {
  const t = T;
  const n = N;
  const openLine = LINE;
  let value = '';
  let seg = open + 1;
  let q = seg;
  let close;
  for (;;) {
    if (QN < q) QN = nextQuote(q);
    if (CN < q) CN = nextCr(q);
    if (LN < q) LN = nextLf(q);
    if (QN >= n) {
      // The quote never closes: a literal character, and the text after it is read again as unquoted. The kept
      // positions were found from past the quote, so they are found again.
      LINE = openLine;
      QN = -1;
      LN = -1;
      CN = -1;
      err('unterminated_quote');
      unquoted(open, '', false);
      return;
    }
    if (CN < QN) {
      // A CR inside the quotes (alone or before LF): one LF.
      while (LN < CN) {
        LINE += 1;
        LN = nextLf(LN + 1);
      }
      value += t.slice(seg, CN) + '\n';
      LINE += 1;
      q = t.charCodeAt(CN + 1) === LF ? CN + 2 : CN + 1;
      seg = q;
      continue;
    }
    while (LN < QN) {
      LINE += 1;
      LN = nextLf(LN + 1);
    }
    if (t.charCodeAt(QN + 1) === QUOTE) {
      value += t.slice(seg, QN + 1);
      q = QN + 2;
      seg = q;
      continue;
    }
    close = QN;
    break;
  }
  value = value === '' ? t.slice(seg, close) : value + t.slice(seg, close);
  const q1 = close + 1; // past the closing quote
  if (q1 >= n) {
    P = q1;
    V = value;
    MORE = false;
    return;
  }
  const d = t.charCodeAt(q1);
  if (d === COMMA) {
    P = q1 + 1;
    V = value;
    MORE = true;
  } else if (d === LF) {
    P = q1 + 1;
    LINE += 1;
    V = value;
    MORE = false;
  } else if (d === CR && t.charCodeAt(q1 + 1) === LF) {
    P = q1 + 2;
    LINE += 1;
    V = value;
    MORE = false;
  } else {
    // What follows the closing quote is appended as it stands (quote_junk when anything is kept).
    unquoted(q1, value, true);
  }
}

/** Reads one record's fields from P (not at a line break); returns whether its last field opened with a quote. */
function record(fields) {
  const t = T;
  const n = N;
  for (;;) {
    const p = P;
    if (p < n && t.charCodeAt(p) === QUOTE) {
      quoted(p);
      fields.push(V);
      if (MORE) continue;
      return true;
    }
    // An unquoted field (a quote in it is a plain character): it ends at the first comma, LF or CR.
    if (MN < p) MN = nextComma(p);
    if (LN < p) LN = nextLf(p);
    if (CN < p) CN = nextCr(p);
    const mn = MN;
    const ln = LN;
    const cn = CN;
    if (mn < ln && mn < cn) {
      fields.push(t.slice(p, mn));
      P = mn + 1;
      continue;
    }
    if (ln <= cn) {
      // To the LF, or to the end of the text (ln = cn = n).
      fields.push(t.slice(p, ln));
      if (ln < n) {
        P = ln + 1;
        LINE += 1;
      } else {
        P = n;
      }
      return false;
    }
    if (cn + 1 === ln && ln < n) {
      // To a CRLF.
      fields.push(t.slice(p, cn));
      P = ln + 1;
      LINE += 1;
      return false;
    }
    // A stray CR before the field's end: this field character by character.
    unquoted(p, '', false);
    fields.push(V);
    if (!MORE) return false;
  }
}

/** csv-reader 1.0.0's answer for one input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  T = text;
  N = n;
  ERRORS = errors;
  P = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  LINE = 1;
  QN = -1;
  LN = -1;
  CN = -1;
  MN = -1;

  for (;;) {
    // Lines with no characters (LF or CRLF alone) are no records.
    let pos = P;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        LINE += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        LINE += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;
    P = pos;

    REC_LINE = LINE;
    REC_ROW = header && columns === null ? null : rows.length;
    const fields = [];
    const wasQuoted = record(fields);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && !wasQuoted && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: REC_LINE, row: REC_ROW, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: REC_LINE, row: REC_ROW, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  T = '';
  ERRORS = [];
  V = '';
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// Warm-up: every branch once, on one-byte and two-byte text, LF and CRLF, with and without a header.
{
  const body = [
    'a,b,c',
    'alpha,"bravo, charlie","say ""hi"""',
    '"multi\nline","cr\r\nlf","lone\rcr"',
    'short',
    'x,y,z,extra,more',
    'stray\rcr,"junk"kg,"ok"\r',
    '',
    '\r',
    '"q"!,"q"\r?,Zürich 東京',
    '1,mid"quote,2.50,2026-11-21',
    '"n1\nn2\rn3\r\nn4\nn5",tail,"a\n\nb"',
    '"j"x"y,z,"j"\r\r',
    'a\r\rb,c\r,"e""""f"',
  ];
  const oneByte = body.map((s) => s.replace(/[^\x00-\xff]/g, '\xe9'));
  for (let i = 0; i < 40; i++) {
    for (const eol of ['\n', '\r\n']) {
      for (const lines of [oneByte, body]) {
        const s = lines.join(eol);
        run({ text: s, header: true });
        run({ text: '\uFEFF' + s + eol + '"never,closed' + eol + 'p,q', header: false });
      }
    }
  }
}
