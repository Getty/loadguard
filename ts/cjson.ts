// The vendored cJSON 1.7.19 (vendor/cJSON/), as far as the hook uses it:
// cJSON_ParseWithLengthOpts, the getters and cJSON_PrintUnformatted. A port,
// not JSON.parse: the decision must read a payload exactly as the C hook
// does — the first of duplicate keys wins, a lone surrogate escape fails the
// text, a string ends at an escaped NUL, bytes <= 32 are whitespace, 1000
// levels of nesting at most, numbers as strtod reads them.
import { type Bytes, general, strtod } from "./bytes.js";

export type JValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: number }
  | { t: "str"; v: Bytes }
  | { t: "arr"; items: JValue[] }
  | { t: "obj"; items: [Bytes, JValue][] };

const NESTING_LIMIT = 1000;

class Buf {
  offset = 0;
  depth = 0;
  constructor(readonly content: Bytes, readonly length: number) {}
  canRead(size: number): boolean {
    return this.offset + size <= this.length;
  }
  canAccess(index: number): boolean {
    return this.offset + index < this.length;
  }
  at(index = 0): number {
    return this.content.charCodeAt(this.offset + index);
  }
  startsWith(word: string): boolean {
    return this.content.startsWith(word, this.offset);
  }
}

function skipWhitespace(b: Buf): void {
  if (!b.canAccess(0)) return;
  while (b.canAccess(0) && b.at() <= 32) b.offset++;
  if (b.offset === b.length) b.offset--;
}

function hex4(s: Bytes, i: number): number {
  let h = 0;
  for (let k = 0; k < 4; k++) {
    const c = s.charCodeAt(i + k);
    if (c >= 0x30 && c <= 0x39) h += c - 0x30;
    else if (c >= 0x41 && c <= 0x46) h += 10 + c - 0x41;
    else if (c >= 0x61 && c <= 0x66) h += 10 + c - 0x61;
    else return 0;
    if (k < 3) h <<= 4;
  }
  return h;
}

function utf8Of(cp: number): string {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  if (cp < 0x10000)
    return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

/** parse_string: the bytes, cut at the first NUL as every C reader sees them. */
function parseString(b: Buf): Bytes | null {
  const s = b.content;
  if (!b.canAccess(0) || b.at() !== 0x22) return null;
  let end = b.offset + 1;
  while (end < b.length && s[end] !== '"') {
    if (s[end] === "\\") {
      if (end + 1 >= b.length) return null;
      end++;
    }
    end++;
  }
  if (end >= b.length || s[end] !== '"') return null;
  let out = "";
  let p = b.offset + 1;
  while (p < end) {
    if (s[p] !== "\\") {
      out += s[p++];
      continue;
    }
    let len = 2;
    switch (s[p + 1]) {
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case '"': case "\\": case "/": out += s[p + 1]; break;
      case "u": {
        if (end - p < 6) return null;
        const first = hex4(s, p + 2);
        let cp: number;
        if (first >= 0xdc00 && first <= 0xdfff) return null;
        if (first >= 0xd800 && first <= 0xdbff) {
          const second = p + 6;
          if (end - second < 6 || s[second] !== "\\" || s[second + 1] !== "u") return null;
          const low = hex4(s, second + 2);
          if (low < 0xdc00 || low > 0xdfff) return null;
          cp = 0x10000 + (((first & 0x3ff) << 10) | (low & 0x3ff));
          len = 12;
        } else {
          cp = first;
          len = 6;
        }
        out += utf8Of(cp);
        break;
      }
      default:
        return null;
    }
    p += len;
  }
  b.offset = end + 1;
  const nul = out.indexOf("\0");
  return nul < 0 ? out : out.slice(0, nul);
}

function parseNumber(b: Buf): JValue | null {
  let n = 0;
  while (b.canAccess(n) && "0123456789+-eE.".includes(b.content[b.offset + n] ?? "x")) n++;
  const text = b.content.slice(b.offset, b.offset + n);
  const [v, end] = strtod(text, 0);
  if (end === 0) return null;
  b.offset += end;
  return { t: "num", v };
}

function parseValue(b: Buf): JValue | null {
  if (b.canRead(4) && b.startsWith("null")) {
    b.offset += 4;
    return { t: "null" };
  }
  if (b.canRead(5) && b.startsWith("false")) {
    b.offset += 5;
    return { t: "bool", v: false };
  }
  if (b.canRead(4) && b.startsWith("true")) {
    b.offset += 4;
    return { t: "bool", v: true };
  }
  if (!b.canAccess(0)) return null;
  const c = b.at();
  if (c === 0x22) {
    const v = parseString(b);
    return v === null ? null : { t: "str", v };
  }
  if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return parseNumber(b);
  if (c === 0x5b || c === 0x7b) return parseContainer(b, c === 0x7b);
  return null;
}

/** parse_array / parse_object. */
function parseContainer(b: Buf, object: boolean): JValue | null {
  const close = object ? 0x7d : 0x5d;
  const arr: JValue[] = [];
  const obj: [Bytes, JValue][] = [];
  if (b.depth >= NESTING_LIMIT) return null;
  b.depth++;
  b.offset++;
  skipWhitespace(b);
  if (!(b.canAccess(0) && b.at() === close)) {
    if (!b.canAccess(0)) return null;
    b.offset--;
    do {
      if (object && !b.canAccess(1)) return null;
      b.offset++;
      skipWhitespace(b);
      let key: Bytes | null = null;
      if (object) {
        key = parseString(b);
        if (key === null) return null;
        skipWhitespace(b);
        if (!b.canAccess(0) || b.at() !== 0x3a) return null;
        b.offset++;
        skipWhitespace(b);
      }
      const v = parseValue(b);
      if (v === null) return null;
      if (key !== null) obj.push([key, v]);
      else arr.push(v);
      skipWhitespace(b);
    } while (b.canAccess(0) && b.at() === 0x2c);
    if (!b.canAccess(0) || b.at() !== close) return null;
  }
  b.depth--;
  b.offset++;
  return object ? { t: "obj", items: obj } : { t: "arr", items: arr };
}

/**
 * cJSON_ParseWithLengthOpts(text, length, &end, nullTerminated): the value
 * and the offset after it, or null. With nullTerminated, text must end in a
 * NUL that length takes in, and only whitespace may come before it.
 */
export function parse(text: Bytes, length: number, nullTerminated: boolean): { value: JValue; end: number } | null {
  if (length === 0) return null;
  const b = new Buf(text, length);
  if (b.canAccess(4) && text.startsWith("\xEF\xBB\xBF")) b.offset += 3;
  skipWhitespace(b);
  const value = parseValue(b);
  if (value === null) return null;
  if (nullTerminated) {
    skipWhitespace(b);
    if (b.offset >= b.length || b.at() !== 0) return null;
  }
  return { value, end: b.offset };
}

/** cJSON_GetObjectItemCaseSensitive: the first item of that name, else null. */
export function get(o: JValue | null, name: Bytes): JValue | null {
  if (o === null || o.t !== "obj") return null;
  for (const [k, v] of o.items) if (k === name) return v;
  return null;
}

/** The string of a string item, else null. */
export function str(v: JValue | null): Bytes | null {
  return v !== null && v.t === "str" ? v.v : null;
}

/** cJSON_ArrayForEach: the children of an array or an object. */
export function children(v: JValue | null): JValue[] {
  if (v === null) return [];
  if (v.t === "arr") return v.items;
  if (v.t === "obj") return v.items.map(([, x]) => x);
  return [];
}

const INT_MAX = 2147483647, INT_MIN = -2147483648;

function compareDouble(a: number, b: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= max * Number.EPSILON;
}

/** print_number. */
function printNumber(d: number): string {
  if (!Number.isFinite(d)) return "null";
  const vi = d >= INT_MAX ? INT_MAX : d <= INT_MIN ? INT_MIN : Math.trunc(d);
  if (d === vi) return String(vi);
  const s = general(d, 15);
  const [back] = strtod(s, 0);
  return compareDouble(back, d) ? s : general(d, 17);
}

/** print_string_ptr. */
function printString(s: Bytes): Bytes {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string, code = s.charCodeAt(i);
    if (code === 0) break;
    if (code > 31 && c !== '"' && c !== "\\") out += c;
    else if (c === "\\" || c === '"') out += "\\" + c;
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else out += "\\u" + code.toString(16).padStart(4, "0");
  }
  return out + '"';
}

/** cJSON_PrintUnformatted. */
export function print(v: JValue): Bytes {
  switch (v.t) {
    case "null": return "null";
    case "bool": return v.v ? "true" : "false";
    case "num": return printNumber(v.v);
    case "str": return printString(v.v);
    case "arr": return "[" + v.items.map(print).join(",") + "]";
    case "obj": return "{" + v.items.map(([k, x]) => printString(k) + ":" + print(x)).join(",") + "}";
  }
}

// Builders for the output trees.
export const jnull: JValue = { t: "null" };
export const jbool = (v: boolean): JValue => ({ t: "bool", v });
export const jnum = (v: number): JValue => ({ t: "num", v });
export const jstr = (v: Bytes): JValue => ({ t: "str", v });
export const jarr = (items: JValue[]): JValue => ({ t: "arr", items });
export const jobj = (items: [Bytes, JValue][]): JValue => ({ t: "obj", items });
