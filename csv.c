// csv-reader 1.0.0's answer for one case, written from the JSON-escaped bytes of its text straight to the JSON bytes of
// its answer. Compiled to WebAssembly with SIMD (build.sh); run.cjs loads it, lays the memory out and drives it.
//
// The input is the inside of one JSON string as JSON.stringify writes it: a quote is \" , a backslash \\ , LF \n ,
// CR \r , and every byte that is not a backslash or a quote stands for itself (UTF-8 passes through untouched). So
// every CSV-significant character is a comma or a two-byte escape, and a field's JSON string in the answer is the very
// bytes of the escaped text it came from, but for csv-reader's own rewrites, made here on the escapes:
//
//   - outside quotes, a field ends at a comma, at \n or at \r\n; a \r not before \n is dropped (stray_cr);
//   - a field that opens with \" runs to the next \" that is not doubled; \"\" inside is one \" ; \r and \r\n inside
//     are one \n (each counts a line, as \n does); what follows the closing \" up to the next comma or line break is
//     appended as it stands (quote_junk when anything is kept); a quote that never closes is a plain character and
//     the text after it is read again unquoted (unterminated_quote), its line count put back;
//   - a leading U+FEFF (EF BB BF) is dropped; a line with no characters is no record, nor is one left empty by its
//     stray CRs; every row is padded with "" (short_row, fields) or cut (long_row, extra) to the first record's width;
//     each error is {code, line, row}, line the one its record starts on, row its index in rows (null: the header).
//
// The text's end is the first raw (unescaped) quote: inside a JSON string every quote is escaped. The scanners stop at
// the first comma, backslash or quote of each 16-byte block, so they need no bounds checks: run.cjs puts quotes past
// the data it has read. The text may be read a window at a time: a raw quote at exactly the end of the data (data_end)
// is not the text's end but the edge of the window, and the record under way there is put back as it was when it
// started, for step() to read again once run.cjs has slid the window on. run.cjs cuts every window just after a \n
// escape, so no escape and none of the lookaheads below (\r\n, \"\") straddles the edge.
//
// The output is written over the input already read: run.cjs puts the input a little past the start of the region
// the answers are written from. Within a field the output never moves ahead of the input (a byte is copied as one
// byte, an escape as itself, and the rewrites shorten), so it is enough to see, as each field starts, that the output
// is at least GAP bytes behind the input, and as much before each padding and before a case's errors are put after its
// rows; a quote that never closes is read again from its opening, so there the output must not have reached it. Any
// of these failing makes step() or finish() return 0, as does a full error region or a \u escape: run.cjs then reads
// the file the ordinary way.

#include <wasm_simd128.h>

typedef unsigned char u8;
typedef unsigned int u32;

#define BS 92 // backslash
#define QU 34 // quote
#define CM 44 // comma

// The byte at offset i of linear memory (an integer made a pointer: arithmetic on a null pointer would be undefined).
#define AT(i) (*(const u8 *)(unsigned long)(i))

static u32 data_end;    // the offset just past the data read so far (a quote sits there)
static u32 line;        // the line the reader is on
static u32 rec_line;    // the line the record being read starts on
static u32 rec_row;     // its index in rows
static int rec_header;  // whether it is the header (row null)
static u8 *out;         // the next output byte
static u8 *err;         // the next byte of this case's errors
static u8 *err_start;   // their start
static u8 *err_lim;     // the end of their region
static int nerr;        // how many this case has
static int bad;         // the input is not what this reads, or a region filled
static int more;        // a scan reached data_end: the record needs the next window
static int field_end;   // how the last field ended: 0 comma, 1 line break, 2 end of text (or of the data)
static u32 added;       // characters the last unquoted read kept
static int need_header; // the next record is the header
static int width;       // the first record's field count (-1: none yet)
static u32 rows;        // records in rows so far
static int fresh;       // the case's first step(): a BOM may lead
static u32 res_i;       // step()'s position: where to go on (more) or the text's end (done)
static u32 text_te;     // the text's end, once step() is done

// How far behind the input the output must be as a field starts: more than the 16-byte block a scanner stores past
// its output pointer, and the few framing bytes written between two fields.
#define GAP 64u

// Whether the output, n bytes on, stays GAP bytes behind input offset i.
#define BEHIND(i, n) ((u32)(unsigned long)out + (n) + GAP <= (i))

static u8 *put(u8 *p, const char *s) {
  while (*s) *p++ = (u8)*s++;
  return p;
}

static u8 *put_num(u8 *p, u32 v) {
  u8 b[10];
  int n = 0;
  do {
    b[n++] = (u8)('0' + v % 10);
    v /= 10;
  } while (v);
  while (n) *p++ = b[--n];
  return p;
}

// Starts an error: {"code":"<code>","line":L,"row":R   (the caller closes it). Returns 0 when the region is full.
static int error_head(const char *code, u32 extra) {
  if (err + 96 + extra > err_lim) {
    bad = 1;
    return 0;
  }
  if (nerr++) *err++ = ',';
  err = put(err, "{\"code\":\"");
  err = put(err, code);
  err = put(err, "\",\"line\":");
  err = put_num(err, rec_line);
  err = put(err, ",\"row\":");
  err = rec_header ? put(err, "null") : put_num(err, rec_row);
  return 1;
}

static void error(const char *code) {
  if (error_head(code, 0)) *err++ = '}';
}

// A raw quote at i: the text's end, or the edge of the data read so far.
static void raw_quote(u32 i) {
  if (i == data_end) more = 1;
  field_end = 2;
}

// An unquoted read from i, copying what it keeps: up to a comma, a line break or the end of the text.
static u32 unquoted(u32 i) {
  const v128_t vc = wasm_i8x16_splat(CM), vb = wasm_i8x16_splat(BS), vq = wasm_i8x16_splat(QU);
  u8 *p = out;
  u32 kept = 0;
  for (;;) {
    v128_t v = wasm_v128_load(&AT(i));
    wasm_v128_store(p, v);
    u32 m = wasm_i8x16_bitmask(wasm_v128_or(wasm_v128_or(wasm_i8x16_eq(v, vc), wasm_i8x16_eq(v, vb)), wasm_i8x16_eq(v, vq)));
    if (!m) {
      i += 16;
      p += 16;
      kept += 16;
      continue;
    }
    u32 k = (u32)__builtin_ctz(m);
    i += k;
    p += k;
    kept += k;
    u8 b = AT(i);
    if (b == CM) {
      i += 1;
      field_end = 0;
      break;
    }
    if (b == QU) {
      raw_quote(i);
      break;
    }
    u8 c = AT(i + 1);
    if (c == 'n') {
      i += 2;
      line += 1;
      field_end = 1;
      break;
    }
    if (c == 'r') {
      if (AT(i + 2) == BS && AT(i + 3) == 'n') {
        i += 4;
        line += 1;
        field_end = 1;
        break;
      }
      error("stray_cr");
      i += 2;
      continue;
    }
    if (c == 'u') bad = 1; // a \u escape may stand for a comma, a quote or a line break: not read here
    // \" (a plain quote here), \\ , \t , \b , \f , \/ : one character, its escape kept.
    p[0] = BS;
    p[1] = c;
    p += 2;
    i += 2;
    kept += 1;
  }
  out = p;
  added = kept;
  return i;
}

static int fcount;      // the record's fields read so far
static u8 *fcut;        // the comma before its first field past the width (0: none yet)
static int opened;      // unquoted_run() ended having opened the next field (it opens with a quote)

// Unquoted fields from i, the first one's opening quote written: like unquoted(), but at a comma it closes the field,
// counts it, writes the comma and opens the next field itself, and goes on while the next field is unquoted too, so
// the common record (unquoted fields only) is read in one loop. It stops at a line break or the end (field_end 1, 2,
// the last field left open), or when the next field opens with a quote (field_end 0, opened set: that field is
// open). Each comma moves the output two bytes nearer the input, so the gap is looked at there.
static u32 unquoted_run(u32 i) {
  const v128_t vc = wasm_i8x16_splat(CM), vb = wasm_i8x16_splat(BS), vq = wasm_i8x16_splat(QU);
  u8 *p = out;
  for (;;) {
    v128_t v = wasm_v128_load(&AT(i));
    wasm_v128_store(p, v);
    u32 m = wasm_i8x16_bitmask(wasm_v128_or(wasm_v128_or(wasm_i8x16_eq(v, vc), wasm_i8x16_eq(v, vb)), wasm_i8x16_eq(v, vq)));
    if (!m) {
      i += 16;
      p += 16;
      continue;
    }
    u32 k = (u32)__builtin_ctz(m);
    i += k;
    p += k;
    u8 b = AT(i);
    if (b == CM) {
      i += 1;
      p[0] = '"';
      fcount += 1;
      if (fcount == width && !fcut) fcut = p + 1;
      p[1] = ',';
      p[2] = '"';
      p += 3;
      if ((u32)(unsigned long)p + GAP > i) {
        bad = 1;
        break;
      }
      if (AT(i) == BS && AT(i + 1) == QU) {
        opened = 1;
        field_end = 0;
        break;
      }
      continue;
    }
    if (b == QU) {
      raw_quote(i);
      break;
    }
    u8 c = AT(i + 1);
    if (c == 'n') {
      i += 2;
      line += 1;
      field_end = 1;
      break;
    }
    if (c == 'r') {
      if (AT(i + 2) == BS && AT(i + 3) == 'n') {
        i += 4;
        line += 1;
        field_end = 1;
        break;
      }
      error("stray_cr");
      i += 2;
      continue;
    }
    if (c == 'u') bad = 1;
    p[0] = BS;
    p[1] = c;
    p += 2;
    i += 2;
  }
  out = p;
  return i;
}

// A field that opens with the escaped quote at i.
static u32 quoted(u32 i) {
  const v128_t vb = wasm_i8x16_splat(BS), vq = wasm_i8x16_splat(QU);
  const u32 open = i, open_line = line;
  u8 *const start = out;
  u8 *p = out;
  i += 2;
  for (;;) {
    v128_t v = wasm_v128_load(&AT(i));
    wasm_v128_store(p, v);
    u32 m = wasm_i8x16_bitmask(wasm_v128_or(wasm_i8x16_eq(v, vb), wasm_i8x16_eq(v, vq)));
    if (!m) {
      i += 16;
      p += 16;
      continue;
    }
    u32 k = (u32)__builtin_ctz(m);
    i += k;
    p += k;
    if (AT(i) == QU) {
      if (i == data_end) {
        more = 1;
        out = p;
        field_end = 2;
        return i;
      }
      // The quote never closes: a plain character, and the text after it is read again unquoted (from bytes the
      // blocks stored for this field must not have reached).
      if ((u32)(unsigned long)p + 16 > open) {
        bad = 1;
        field_end = 2;
        return i;
      }
      out = start;
      line = open_line;
      error("unterminated_quote");
      return unquoted(open);
    }
    u8 c = AT(i + 1);
    if (c == QU) {
      if (AT(i + 2) == BS && AT(i + 3) == QU) {
        p[0] = BS;
        p[1] = QU;
        p += 2;
        i += 4;
        continue;
      }
      i += 2;
      break;
    }
    if (c == 'r') {
      p[0] = BS;
      p[1] = 'n';
      p += 2;
      line += 1;
      i += (AT(i + 2) == BS && AT(i + 3) == 'n') ? 4 : 2;
      continue;
    }
    if (c == 'n') line += 1;
    if (c == 'u') bad = 1;
    p[0] = BS;
    p[1] = c;
    p += 2;
    i += 2;
  }
  out = p;
  u8 b = AT(i);
  if (b == QU) {
    raw_quote(i);
    return i;
  }
  if (b == CM) {
    field_end = 0;
    return i + 1;
  }
  if (b == BS) {
    u8 c = AT(i + 1);
    if (c == 'n') {
      line += 1;
      field_end = 1;
      return i + 2;
    }
    if (c == 'r' && AT(i + 2) == BS && AT(i + 3) == 'n') {
      line += 1;
      field_end = 1;
      return i + 4;
    }
  }
  // What follows the closing quote is appended as it stands (quote_junk when anything is kept).
  i = unquoted(i);
  if (added) error("quote_junk");
  return i;
}

// Where the JSON string whose content starts at i ends: its first quote not escaped (a backslash takes the byte after
// it). run.cjs puts quotes past the end of the data, so the scan always stops.
__attribute__((export_name("text_end")))
u32 text_end(u32 i) {
  const v128_t vb = wasm_i8x16_splat(BS), vq = wasm_i8x16_splat(QU);
  for (;;) {
    v128_t v = wasm_v128_load(&AT(i));
    u32 m = wasm_i8x16_bitmask(wasm_v128_or(wasm_i8x16_eq(v, vb), wasm_i8x16_eq(v, vq)));
    if (!m) {
      i += 16;
      continue;
    }
    i += (u32)__builtin_ctz(m);
    if (AT(i) == QU) return i;
    i += 2;
  }
}

// Starts a case's answer at op (its header flag given): writes its head and readies the reader. Returns the output
// position.
__attribute__((export_name("begin")))
u32 begin(u32 header, u32 op, u32 ep, u32 elim) {
  out = (u8 *)op;
  err = err_start = (u8 *)ep;
  err_lim = (u8 *)elim;
  nerr = 0;
  bad = 0;
  line = 1;
  need_header = header != 0;
  width = -1;
  rows = 0;
  fresh = 1;
  out = put(out, need_header ? "{\"columns\":" : "{\"columns\":null,\"rows\":[");
  return (u32)out;
}

__attribute__((export_name("res_i"))) u32 get_res_i(void) { return res_i; }
__attribute__((export_name("res_o"))) u32 get_res_o(void) { return (u32)(unsigned long)out; }

// Reads the case's records from i, writing at op, with data up to dend. Returns 1 when the text has ended (res_i its
// end), 2 when the next record needs more data (res_i where it starts), 0 when the input is not read here; res_o is
// the output position.
__attribute__((export_name("step")))
u32 step(u32 i, u32 dend, u32 op) {
  data_end = dend;
  out = (u8 *)op;
  more = 0;
  if (fresh) {
    if (AT(i) == 0xEF && AT(i + 1) == 0xBB && AT(i + 2) == 0xBF) i += 3;
    fresh = 0;
  }
  for (;;) {
    // Lines with no characters are no records.
    while (AT(i) == BS) {
      if (AT(i + 1) == 'n') {
        i += 2;
        line += 1;
      } else if (AT(i + 1) == 'r' && AT(i + 2) == BS && AT(i + 3) == 'n') {
        i += 4;
        line += 1;
      } else {
        break;
      }
    }
    if (AT(i) == QU) {
      res_i = i;
      if (i == data_end) return 2;
      text_te = i;
      return 1;
    }
    rec_line = line;
    rec_header = need_header;
    rec_row = rows;
    const u32 rec_i = i;
    u8 *const rec_start = out;
    u8 *const rec_err = err;
    const int rec_nerr = nerr;
    if (!need_header && rows) *out++ = ',';
    *out++ = '[';
    fcount = 0;
    fcut = 0;
    int last_quoted = 0;
    u8 *last_start = out;
    *out++ = '"';
    for (;;) {
      if (!BEHIND(i, 0)) return 0;
      last_start = out;
      last_quoted = AT(i) == BS && AT(i + 1) == QU;
      opened = 0;
      i = last_quoted ? quoted(i) : unquoted_run(i);
      if (bad) return 0;
      if (more) {
        // The record runs past the data: put it back as it was, to be read again from its start.
        out = rec_start;
        err = rec_err;
        nerr = rec_nerr;
        line = rec_line;
        res_i = rec_i;
        return 2;
      }
      if (opened) continue; // unquoted_run() closed its fields and opened the next, quoted one
      *out++ = '"';
      fcount += 1;
      if (field_end) break;
      if (fcount == width && !fcut) fcut = out;
      out[0] = ',';
      out[1] = '"';
      out += 2;
    }
    const int count = fcount;
    u8 *const cut = fcut; // the comma before the first field past the width
    // A line left with no characters by its stray CRs is no record (its stray_cr errors stay).
    if (count == 1 && !last_quoted && out == last_start + 1) {
      out = rec_start;
      continue;
    }
    if (width < 0) width = count;
    if (need_header) {
      *out++ = ']';
      out = put(out, ",\"rows\":[");
      need_header = 0;
      continue;
    }
    if (count < width) {
      if (!error_head("short_row", 16)) return 0;
      err = put(err, ",\"fields\":");
      err = put_num(err, (u32)count);
      *err++ = '}';
      if (!BEHIND(i, 3 * (u32)(width - count) + 16)) return 0;
      for (int k = count; k < width; k++) {
        out[0] = ',';
        out[1] = '"';
        out[2] = '"';
        out += 3;
      }
    } else if (count > width) {
      u32 n = (u32)(out - cut - 1);
      if (!error_head("long_row", n + 16)) return 0;
      err = put(err, ",\"extra\":[");
      __builtin_memcpy(err, cut + 1, n);
      err += n;
      *err++ = ']';
      *err++ = '}';
      out = cut;
    }
    *out++ = ']';
    rows += 1;
  }
}

static u32 errors_left; // bytes of errors finish() left in their region for run.cjs to write (then "]}")

__attribute__((export_name("errors_left"))) u32 get_errors_left(void) { return errors_left; }

// Ends the case's answer at op once step() is done: the errors after the rows. Returns the output position, or 0.
// Errors that would not fit behind the input (a file whose every row is long, say) are left where they are:
// errors_left() says how many bytes, for run.cjs to write from the error region itself, followed by "]}".
__attribute__((export_name("finish")))
u32 finish(u32 op) {
  out = (u8 *)op;
  if (bad) return 0;
  u32 n = (u32)(err - err_start);
  if (need_header) out = put(out, "[],\"rows\":[");
  out = put(out, "],\"errors\":[");
  if (BEHIND(text_te, n + 32)) {
    __builtin_memcpy(out, err_start, n);
    out += n;
    out = put(out, "]}");
    errors_left = 0;
  } else {
    errors_left = n;
  }
  return (u32)(unsigned long)out;
}
