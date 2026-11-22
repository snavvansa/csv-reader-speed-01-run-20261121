// csv-reader 1.0.0's answer for one case, written from the JSON-escaped bytes of its text straight to the JSON bytes of
// its answer. Compiled to WebAssembly with SIMD (build.sh); main.ts loads it, lays the memory out and calls answer().
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
// The text's end is the raw quote that closes its JSON string (main.ts finds it and passes its offset as te), so the
// scanners need no bounds checks: they stop at the first comma, backslash or quote of each 16-byte block, and a raw
// quote anywhere before te means the input is not what this reads (answer() returns 0 and main.ts reads the file the
// ordinary way). Blocks are copied to the output whole and the output pointer moves only past the bytes kept.
//
// The output is written over the input it has already read: main.ts puts the input a little past the start of the
// region the answers are written from, so the whole file is written with one call and no page is touched twice.
// Within a field the output never moves ahead of the input (a byte is copied as one byte, an escape as itself, and
// the rewrites shorten), so it is enough to see, as each field starts, that the output is at least GAP bytes behind
// the input, and as much before each padding and before a case's errors are put after its rows; a quote that never
// closes is read again from its opening, so there the output must not have reached it. Any of these failing returns
// 0, as does a full error region.

#include <wasm_simd128.h>

typedef unsigned char u8;
typedef unsigned int u32;

#define BS 92 // backslash
#define QU 34 // quote
#define CM 44 // comma

// The byte at offset i of linear memory (an integer made a pointer: arithmetic on a null pointer would be undefined).
#define AT(i) (*(const u8 *)(unsigned long)(i))

static u32 te;          // the offset of the raw quote that ends the text
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
static int field_end;   // how the last field ended: 0 comma, 1 line break, 2 end of text
static u32 added;       // characters the last unquoted read kept

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
static int error_head(const char *code, u32 more) {
  if (err + 96 + more > err_lim) {
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
      if (i != te) bad = 1;
      field_end = 2;
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
      if (i != te) {
        bad = 1;
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
    if (i != te) bad = 1;
    field_end = 2;
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
// it). main.ts puts quotes past the end of the input, so the scan always stops.
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

// Writes the answer for the escaped text [ts, te_) at op, behind it; returns the offset past it, or 0 (read the file
// the ordinary way).
__attribute__((export_name("answer")))
u32 answer(u32 ts, u32 te_, u32 header, u32 op, u32 ep, u32 elim) {
  te = te_;
  out = (u8 *)op;
  if (!BEHIND(ts, 32)) return 0;
  err = err_start = (u8 *)ep;
  err_lim = (u8 *)elim;
  nerr = 0;
  bad = 0;
  line = 1;
  u32 i = ts;
  if (te - ts >= 3 && AT(i) == 0xEF && AT(i + 1) == 0xBB && AT(i + 2) == 0xBF) i += 3;
  int need_header = header != 0;
  int width = -1;
  u32 rows = 0;
  out = put(out, need_header ? "{\"columns\":" : "{\"columns\":null,\"rows\":[");
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
    if (i >= te) break;
    rec_line = line;
    rec_header = need_header;
    rec_row = rows;
    u8 *const rec_start = out;
    if (!need_header && rows) *out++ = ',';
    *out++ = '[';
    int count = 0;
    u8 *cut = 0; // the comma before the first field past the width
    int last_quoted = 0;
    u8 *last_start = out;
    for (;;) {
      if (count) {
        if (count == width && !cut) cut = out;
        *out++ = ',';
      }
      *out++ = '"';
      if (!BEHIND(i, 0)) return 0;
      last_start = out;
      last_quoted = AT(i) == BS && AT(i + 1) == QU;
      i = last_quoted ? quoted(i) : unquoted(i);
      if (bad) return 0;
      *out++ = '"';
      count += 1;
      if (field_end) break;
    }
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
  u32 n = (u32)(err - err_start);
  if (!BEHIND(te, n + 32)) return 0;
  if (need_header) out = put(out, "[],\"rows\":[");
  out = put(out, "],\"errors\":[");
  __builtin_memcpy(out, err_start, n);
  out += n;
  out = put(out, "]}");
  return bad ? 0 : (u32)out;
}
