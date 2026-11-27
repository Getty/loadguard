// C strings and C formatting for the port of src/loadguard-hook.c.
//
// Every string the hook handles is a byte string here: one char per byte
// (latin1), so a cut at N bytes, a UTF-8 check or a byte compare does what the
// C does, also on text that is not UTF-8. Numbers print as glibc's printf and
// cJSON print them (exact decimal expansion, ties to even).

/** A byte string: every char code is 0-255. */
export type Bytes = string;

/** Bytes of a file or a stream as a byte string. */
export function fromBuffer(buf: Uint8Array): Bytes {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("latin1");
}

/** A JS string (an env value, a path from the runtime) as its UTF-8 bytes. */
export function utf8Bytes(s: string): Bytes {
  return Buffer.from(s, "utf8").toString("latin1");
}

/** A byte string back to bytes, for output. */
export function toBuffer(s: Bytes): Buffer {
  return Buffer.from(s, "latin1");
}

/** A path for the runtime's file API, byte for byte. */
export function pathOf(s: Bytes): Buffer {
  return Buffer.from(s, "latin1");
}

/** What a C function sees of s: up to the first NUL. */
export function cstr(s: Bytes): Bytes {
  const nul = s.indexOf("\0");
  return nul < 0 ? s : s.slice(0, nul);
}

/** snprintf into size bytes: at most size - 1 of s. */
export function fit(s: Bytes, size: number): Bytes {
  return s.length < size ? s : s.slice(0, Math.max(0, size - 1));
}

export function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

export function isAlpha(c: string | undefined): boolean {
  return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}

/** isspace() in the C locale. */
export function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";
}

/** valid_utf8(): well-formed UTF-8 without NUL bytes. */
export function validUtf8(s: Bytes): boolean {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    let k: number, cp: number, min: number;
    if (c === 0) return false;
    if (c < 0x80) {
      i++;
      continue;
    }
    if ((c & 0xe0) === 0xc0) {
      k = 1; cp = c & 0x1f; min = 0x80;
    } else if ((c & 0xf0) === 0xe0) {
      k = 2; cp = c & 0x0f; min = 0x800;
    } else if ((c & 0xf8) === 0xf0) {
      k = 3; cp = c & 0x07; min = 0x10000;
    } else {
      return false;
    }
    if (n - i <= k) return false;
    for (let j = 1; j <= k; j++) {
      const d = s.charCodeAt(i + j);
      if ((d & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += k + 1;
  }
  return true;
}

const U64 = (1n << 64n) - 1n;

/**
 * number(): a decimal at s[i] (leading blanks and tabs allowed) as strtoull
 * reads it; null without a digit or on overflow (ERANGE).
 */
export function number(s: Bytes, i = 0): bigint | null {
  while (s[i] === " " || s[i] === "\t") i++;
  if (!isDigit(s[i])) return null;
  let j = i;
  while (isDigit(s[j])) j++;
  const v = BigInt(s.slice(i, j));
  return v > U64 ? null : v;
}

/** Unsigned 64-bit wrap-around, as unsigned long long arithmetic does. */
export function u64(v: bigint): bigint {
  return BigInt.asUintN(64, v);
}

/** (int) of an integer: the low 32 bits, as gcc converts. */
export function int32(v: bigint): number {
  return Number(BigInt.asIntN(32, v));
}

/**
 * strtod(s + i): the value and the index after it; end === i if nothing was
 * converted. Decimal, hex, inf and nan as glibc reads them in the C locale.
 */
export function strtod(s: Bytes, i: number): [number, number] {
  let p = i;
  while (isSpace(s[p])) p++;
  let sign = 1;
  if (s[p] === "+" || s[p] === "-") {
    if (s[p] === "-") sign = -1;
    p++;
  }
  const rest = s.slice(p);
  let m = /^inf(inity)?/i.exec(rest);
  if (m) return [sign * Infinity, p + m[0].length];
  m = /^nan(\([0-9A-Za-z_]*\))?/i.exec(rest);
  if (m) return [NaN, p + m[0].length];
  m = /^0[xX]([0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)([pP][+-]?[0-9]+)?/.exec(rest);
  if (m) {
    const [whole = "", frac = ""] = (m[1] ?? "").split(".");
    const mant = BigInt("0x0" + whole + frac);
    const exp = (m[2] ? Number(m[2].slice(1)) : 0) - 4 * frac.length;
    return [sign * Number(mant) * Math.pow(2, exp), p + m[0].length];
  }
  m = /^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?/.exec(rest);
  if (m) return [sign * Number(m[0]), p + m[0].length];
  return [0, i];
}

/** x = digits / 10^scale exactly, for a finite x >= 0. */
function exact(x: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const e = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (e === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = e - 1075;
  }
  if (exp >= 0) return { digits: mant << BigInt(exp), scale: 0 };
  return { digits: mant * 5n ** BigInt(-exp), scale: -exp };
}

/** digits / 10^k rounded to nearest, ties to even (k > 0). */
function roundDiv(digits: bigint, k: number): bigint {
  const d = 10n ** BigInt(k);
  let q = digits / d;
  const r = digits % d, half = d / 2n;
  if (r > half || (r === half && q % 2n === 1n)) q++;
  return q;
}

function negative(x: number): boolean {
  return x < 0 || Object.is(x, -0);
}

function special(x: number): string | null {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
  return null;
}

/** printf("%.<prec>f", x). */
export function fixed(x: number, prec: number): string {
  const sp = special(x);
  if (sp !== null) return sp;
  const { digits, scale } = exact(Math.abs(x));
  const q = scale <= prec ? digits * 10n ** BigInt(prec - scale) : roundDiv(digits, scale - prec);
  let s = q.toString().padStart(prec + 1, "0");
  if (prec > 0) s = s.slice(0, s.length - prec) + "." + s.slice(s.length - prec);
  return (negative(x) ? "-" : "") + s;
}

/** printf("%.<prec>g", x). */
export function general(x: number, precision: number): string {
  const sp = special(x);
  if (sp !== null) return sp;
  const P = precision === 0 ? 1 : precision;
  let m: string, X: number;
  if (x === 0) {
    m = "0".repeat(P);
    X = 0;
  } else {
    const { digits, scale } = exact(Math.abs(x));
    const D = digits.toString();
    X = D.length - 1 - scale;
    if (D.length <= P) {
      m = D.padEnd(P, "0");
    } else {
      let q = roundDiv(digits, D.length - P);
      if (q === 10n ** BigInt(P)) {
        q = 10n ** BigInt(P - 1);
        X++;
      }
      m = q.toString();
    }
  }
  const strip = (int: string, frac: string) => {
    frac = frac.replace(/0+$/, "");
    return frac === "" ? int : int + "." + frac;
  };
  let body: string;
  if (X < -4 || X >= P) {
    const e = Math.abs(X).toString().padStart(2, "0");
    body = strip(m[0] ?? "0", m.slice(1)) + "e" + (X < 0 ? "-" : "+") + e;
  } else if (X >= 0) {
    body = strip(m.slice(0, X + 1), m.slice(X + 1));
  } else {
    body = strip("0", "0".repeat(-X - 1) + m);
  }
  return (negative(x) ? "-" : "") + body;
}
