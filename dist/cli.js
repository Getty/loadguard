// @bun
// ts/bytes.ts
function fromBuffer(buf) {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("latin1");
}
function utf8Bytes(s) {
  return Buffer.from(s, "utf8").toString("latin1");
}
function toBuffer(s) {
  return Buffer.from(s, "latin1");
}
function pathOf(s) {
  return Buffer.from(s, "latin1");
}
function cstr(s) {
  const nul = s.indexOf("\x00");
  return nul < 0 ? s : s.slice(0, nul);
}
function fit(s, size) {
  return s.length < size ? s : s.slice(0, Math.max(0, size - 1));
}
function isDigit(c) {
  return c !== undefined && c >= "0" && c <= "9";
}
function isAlpha(c) {
  return c !== undefined && (c >= "a" && c <= "z" || c >= "A" && c <= "Z");
}
function isSpace(c) {
  return c === " " || c === "\t" || c === `
` || c === "\v" || c === "\f" || c === "\r";
}
function validUtf8(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    let k, cp, min;
    if (c === 0)
      return false;
    if (c < 128) {
      i++;
      continue;
    }
    if ((c & 224) === 192) {
      k = 1;
      cp = c & 31;
      min = 128;
    } else if ((c & 240) === 224) {
      k = 2;
      cp = c & 15;
      min = 2048;
    } else if ((c & 248) === 240) {
      k = 3;
      cp = c & 7;
      min = 65536;
    } else {
      return false;
    }
    if (n - i <= k)
      return false;
    for (let j = 1;j <= k; j++) {
      const d = s.charCodeAt(i + j);
      if ((d & 192) !== 128)
        return false;
      cp = cp << 6 | d & 63;
    }
    if (cp < min || cp > 1114111 || cp >= 55296 && cp <= 57343)
      return false;
    i += k + 1;
  }
  return true;
}
var U64 = (1n << 64n) - 1n;
function number(s, i = 0) {
  while (s[i] === " " || s[i] === "\t")
    i++;
  if (!isDigit(s[i]))
    return null;
  let j = i;
  while (isDigit(s[j]))
    j++;
  const v = BigInt(s.slice(i, j));
  return v > U64 ? null : v;
}
function u64(v) {
  return BigInt.asUintN(64, v);
}
function int32(v) {
  return Number(BigInt.asIntN(32, v));
}
function strtod(s, i) {
  let p = i;
  while (isSpace(s[p]))
    p++;
  let sign = 1;
  if (s[p] === "+" || s[p] === "-") {
    if (s[p] === "-")
      sign = -1;
    p++;
  }
  const rest = s.slice(p);
  let m = /^inf(inity)?/i.exec(rest);
  if (m)
    return [sign * Infinity, p + m[0].length];
  m = /^nan(\([0-9A-Za-z_]*\))?/i.exec(rest);
  if (m)
    return [NaN, p + m[0].length];
  m = /^0[xX]([0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)([pP][+-]?[0-9]+)?/.exec(rest);
  if (m) {
    const [whole = "", frac = ""] = (m[1] ?? "").split(".");
    const mant = BigInt("0x0" + whole + frac);
    const exp = (m[2] ? Number(m[2].slice(1)) : 0) - 4 * frac.length;
    return [sign * Number(mant) * Math.pow(2, exp), p + m[0].length];
  }
  m = /^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?/.exec(rest);
  if (m)
    return [sign * Number(m[0]), p + m[0].length];
  return [0, i];
}
function exact(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const e = hi >>> 20 & 2047;
  let mant = BigInt(hi & 1048575) << 32n | BigInt(lo);
  let exp;
  if (e === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = e - 1075;
  }
  if (exp >= 0)
    return { digits: mant << BigInt(exp), scale: 0 };
  return { digits: mant * 5n ** BigInt(-exp), scale: -exp };
}
function roundDiv(digits, k) {
  const d = 10n ** BigInt(k);
  let q = digits / d;
  const r = digits % d, half = d / 2n;
  if (r > half || r === half && q % 2n === 1n)
    q++;
  return q;
}
function negative(x) {
  return x < 0 || Object.is(x, -0);
}
function special(x) {
  if (Number.isNaN(x))
    return "nan";
  if (!Number.isFinite(x))
    return x < 0 ? "-inf" : "inf";
  return null;
}
function fixed(x, prec) {
  const sp = special(x);
  if (sp !== null)
    return sp;
  const { digits, scale } = exact(Math.abs(x));
  const q = scale <= prec ? digits * 10n ** BigInt(prec - scale) : roundDiv(digits, scale - prec);
  let s = q.toString().padStart(prec + 1, "0");
  if (prec > 0)
    s = s.slice(0, s.length - prec) + "." + s.slice(s.length - prec);
  return (negative(x) ? "-" : "") + s;
}
function general(x, precision) {
  const sp = special(x);
  if (sp !== null)
    return sp;
  const P = precision === 0 ? 1 : precision;
  let m, X;
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
  const strip = (int, frac) => {
    frac = frac.replace(/0+$/, "");
    return frac === "" ? int : int + "." + frac;
  };
  let body;
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

// ts/cjson.ts
var NESTING_LIMIT = 1000;

class Buf {
  content;
  length;
  offset = 0;
  depth = 0;
  constructor(content, length) {
    this.content = content;
    this.length = length;
  }
  canRead(size) {
    return this.offset + size <= this.length;
  }
  canAccess(index) {
    return this.offset + index < this.length;
  }
  at(index = 0) {
    return this.content.charCodeAt(this.offset + index);
  }
  startsWith(word) {
    return this.content.startsWith(word, this.offset);
  }
}
function skipWhitespace(b) {
  if (!b.canAccess(0))
    return;
  while (b.canAccess(0) && b.at() <= 32)
    b.offset++;
  if (b.offset === b.length)
    b.offset--;
}
function hex4(s, i) {
  let h = 0;
  for (let k = 0;k < 4; k++) {
    const c = s.charCodeAt(i + k);
    if (c >= 48 && c <= 57)
      h += c - 48;
    else if (c >= 65 && c <= 70)
      h += 10 + c - 65;
    else if (c >= 97 && c <= 102)
      h += 10 + c - 97;
    else
      return 0;
    if (k < 3)
      h <<= 4;
  }
  return h;
}
function utf8Of(cp) {
  if (cp < 128)
    return String.fromCharCode(cp);
  if (cp < 2048)
    return String.fromCharCode(192 | cp >> 6, 128 | cp & 63);
  if (cp < 65536)
    return String.fromCharCode(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
  return String.fromCharCode(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
}
function parseString(b) {
  const s = b.content;
  if (!b.canAccess(0) || b.at() !== 34)
    return null;
  let end = b.offset + 1;
  while (end < b.length && s[end] !== '"') {
    if (s[end] === "\\") {
      if (end + 1 >= b.length)
        return null;
      end++;
    }
    end++;
  }
  if (end >= b.length || s[end] !== '"')
    return null;
  let out = "";
  let p = b.offset + 1;
  while (p < end) {
    if (s[p] !== "\\") {
      out += s[p++];
      continue;
    }
    let len = 2;
    switch (s[p + 1]) {
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += `
`;
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case '"':
      case "\\":
      case "/":
        out += s[p + 1];
        break;
      case "u": {
        if (end - p < 6)
          return null;
        const first = hex4(s, p + 2);
        let cp;
        if (first >= 56320 && first <= 57343)
          return null;
        if (first >= 55296 && first <= 56319) {
          const second = p + 6;
          if (end - second < 6 || s[second] !== "\\" || s[second + 1] !== "u")
            return null;
          const low = hex4(s, second + 2);
          if (low < 56320 || low > 57343)
            return null;
          cp = 65536 + ((first & 1023) << 10 | low & 1023);
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
  const nul = out.indexOf("\x00");
  return nul < 0 ? out : out.slice(0, nul);
}
function parseNumber(b) {
  let n = 0;
  while (b.canAccess(n) && "0123456789+-eE.".includes(b.content[b.offset + n] ?? "x"))
    n++;
  const text = b.content.slice(b.offset, b.offset + n);
  const [v, end] = strtod(text, 0);
  if (end === 0)
    return null;
  b.offset += end;
  return { t: "num", v };
}
function parseValue(b) {
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
  if (!b.canAccess(0))
    return null;
  const c = b.at();
  if (c === 34) {
    const v = parseString(b);
    return v === null ? null : { t: "str", v };
  }
  if (c === 45 || c >= 48 && c <= 57)
    return parseNumber(b);
  if (c === 91 || c === 123)
    return parseContainer(b, c === 123);
  return null;
}
function parseContainer(b, object) {
  const close = object ? 125 : 93;
  const arr = [];
  const obj = [];
  if (b.depth >= NESTING_LIMIT)
    return null;
  b.depth++;
  b.offset++;
  skipWhitespace(b);
  if (!(b.canAccess(0) && b.at() === close)) {
    if (!b.canAccess(0))
      return null;
    b.offset--;
    do {
      if (object && !b.canAccess(1))
        return null;
      b.offset++;
      skipWhitespace(b);
      let key = null;
      if (object) {
        key = parseString(b);
        if (key === null)
          return null;
        skipWhitespace(b);
        if (!b.canAccess(0) || b.at() !== 58)
          return null;
        b.offset++;
        skipWhitespace(b);
      }
      const v = parseValue(b);
      if (v === null)
        return null;
      if (key !== null)
        obj.push([key, v]);
      else
        arr.push(v);
      skipWhitespace(b);
    } while (b.canAccess(0) && b.at() === 44);
    if (!b.canAccess(0) || b.at() !== close)
      return null;
  }
  b.depth--;
  b.offset++;
  return object ? { t: "obj", items: obj } : { t: "arr", items: arr };
}
function parse(text, length, nullTerminated) {
  if (length === 0)
    return null;
  const b = new Buf(text, length);
  if (b.canAccess(4) && text.startsWith("\xEF\xBB\xBF"))
    b.offset += 3;
  skipWhitespace(b);
  const value = parseValue(b);
  if (value === null)
    return null;
  if (nullTerminated) {
    skipWhitespace(b);
    if (b.offset >= b.length || b.at() !== 0)
      return null;
  }
  return { value, end: b.offset };
}
function get(o, name) {
  if (o === null || o.t !== "obj")
    return null;
  for (const [k, v] of o.items)
    if (k === name)
      return v;
  return null;
}
function str(v) {
  return v !== null && v.t === "str" ? v.v : null;
}
function children(v) {
  if (v === null)
    return [];
  if (v.t === "arr")
    return v.items;
  if (v.t === "obj")
    return v.items.map(([, x]) => x);
  return [];
}
var INT_MAX = 2147483647;
var INT_MIN = -2147483648;
function compareDouble(a, b) {
  const max = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= max * Number.EPSILON;
}
function printNumber(d) {
  if (!Number.isFinite(d))
    return "null";
  const vi = d >= INT_MAX ? INT_MAX : d <= INT_MIN ? INT_MIN : Math.trunc(d);
  if (d === vi)
    return String(vi);
  const s = general(d, 15);
  const [back] = strtod(s, 0);
  return compareDouble(back, d) ? s : general(d, 17);
}
function printString(s) {
  let out = '"';
  for (let i = 0;i < s.length; i++) {
    const c = s[i], code = s.charCodeAt(i);
    if (code === 0)
      break;
    if (code > 31 && c !== '"' && c !== "\\")
      out += c;
    else if (c === "\\" || c === '"')
      out += "\\" + c;
    else if (c === "\b")
      out += "\\b";
    else if (c === "\f")
      out += "\\f";
    else if (c === `
`)
      out += "\\n";
    else if (c === "\r")
      out += "\\r";
    else if (c === "\t")
      out += "\\t";
    else
      out += "\\u" + code.toString(16).padStart(4, "0");
  }
  return out + '"';
}
function print(v) {
  switch (v.t) {
    case "null":
      return "null";
    case "bool":
      return v.v ? "true" : "false";
    case "num":
      return printNumber(v.v);
    case "str":
      return printString(v.v);
    case "arr":
      return "[" + v.items.map(print).join(",") + "]";
    case "obj":
      return "{" + v.items.map(([k, x]) => printString(k) + ":" + print(x)).join(",") + "}";
  }
}
var jnull = { t: "null" };
var jbool = (v) => ({ t: "bool", v });
var jnum = (v) => ({ t: "num", v });
var jstr = (v) => ({ t: "str", v });
var jarr = (items) => ({ t: "arr", items });
var jobj = (items) => ({ t: "obj", items });

// ts/learnlist.ts
import { closeSync, constants as constants2, existsSync as existsSync2, fsyncSync, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync2, readSync, renameSync as renameSync2, statSync as statSync2, unlinkSync, writeSync } from "fs";

// ts/libc.ts
import { CString, dlopen, FFIType, read } from "bun:ffi";
var libc;
function loadLibc() {
  if (libc !== undefined)
    return libc;
  try {
    const lib = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      getpwuid: { args: [FFIType.u32], returns: FFIType.ptr },
      strerror: { args: [FFIType.i32], returns: FFIType.cstring }
    });
    libc = {
      flock: (fd, op) => lib.symbols.flock(fd, op),
      userName: (uid) => {
        const pw = lib.symbols.getpwuid(uid);
        if (pw === null)
          return null;
        const name = read.ptr(pw, 0);
        return name === 0 ? null : new CString(name).toString();
      },
      strerror: (errno) => String(lib.symbols.strerror(errno))
    };
  } catch {
    libc = null;
  }
  return libc;
}

// ts/lock.ts
import { spawnSync } from "child_process";
var LOCK_EX = 2;
var LOCK_NB = 4;
var forced = null;
function flock1(fd, nonBlocking) {
  try {
    const r = spawnSync("flock", nonBlocking ? ["-x", "-n", "3"] : ["-x", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd]
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
function lockFile(fd, nonBlocking) {
  const libc = forced === "flock1" ? null : loadLibc();
  if (libc !== null)
    return libc.flock(fd, LOCK_EX | (nonBlocking ? LOCK_NB : 0)) === 0;
  return forced === "ffi" ? false : flock1(fd, nonBlocking);
}

// ts/scope.ts
import { spawn } from "child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { setPriority } from "os";
var SLICE = "app-loadguard.slice";
var PREFIX = "loadguard-";
var DEFAULTS = [
  ["MemoryHigh", "LOADGUARD_MEMORY_HIGH", 30, 1, 100],
  ["MemoryMax", "LOADGUARD_MEMORY_MAX", 40, 1, 100],
  ["MemorySwapMax", "LOADGUARD_MEMORY_SWAP_MAX", 10, 0, 100],
  ["CPUWeight", "LOADGUARD_CPU_WEIGHT", 50, 1, 1e4]
];
var SESSION_NAMES = ["claude", "codex"];
var MAX_DEPTH = 8;
var BUSCTL_TIMEOUT_S = 2;
var CONFIRM_S = 1;
var BUN_ENV_REMOVED = [
  "BUN_OPTIONS",
  "BUN_INSPECT_PRELOAD",
  "BUN_INSPECT",
  "BUN_INSPECT_CONNECT_TO",
  "NODE_PATH",
  "NODE_COMPILE_CACHE",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "BUN_INTERNAL_WEBVIEW_HOST"
];

class PyError extends Error {
  kind;
  constructor(kind, message) {
    super(kind + ": " + message);
    this.kind = kind;
  }
}
var PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
var SPLIT = new RegExp(`[${PY_WS}]+`);
var LINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
var MEMTOTAL = new RegExp(`(?:^|(?<=\\n))MemTotal:[${PY_WS}]+([0-9]+) kB(?=\\n|$)`);
function pyStrip(s) {
  return s.replace(STRIP, "");
}
function pySplit(s) {
  return s.split(SPLIT).filter((w) => w !== "");
}
function pySplitlines(s) {
  const lines = s.split(LINES);
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines;
}
function pyInt(s) {
  const t = pyStrip(s);
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(t))
    throw new PyError("ValueError", "invalid literal for int(): " + s);
  return Number(BigInt(t.replace(/_/g, "")));
}
function pyJoin(a, ...parts) {
  let out = a;
  for (const p of parts)
    out = p.startsWith("/") ? p : out === "" || out.endsWith("/") ? out + p : out + "/" + p;
  return out;
}
function wellFormed(s) {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}
function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}
function dirname(p) {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  return head !== "" && head !== "/".repeat(head.length) ? head.replace(/\/+$/, "") : head;
}
function makedirs(path, mode) {
  const head = dirname(path);
  if (head !== "" && basename(path) !== "" && !existsSync(head))
    makedirs(head, 511);
  try {
    mkdirSync(path, { mode });
  } catch (e) {
    let dir = false;
    try {
      dir = statSync(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir)
      throw new PyError("OSError", String(e));
  }
}
var DECODER = new TextDecoder("utf-8");
function read2(root, path) {
  let buf;
  try {
    buf = readFileSync(root + path);
  } catch (e) {
    throw new PyError("OSError", String(e));
  }
  return DECODER.decode(buf).replace(/\r\n?/g, `
`);
}
function memTotal(root) {
  const m = MEMTOTAL.exec(read2(root, "/proc/meminfo"));
  return m === null ? null : BigInt(m[1]) * 1024n;
}
function envInt(environ, name, def, lo, hi) {
  const m = /^([0-9]+)%?$/.exec(environ[name] ?? "");
  if (m !== null) {
    const n = BigInt(m[1]);
    if (BigInt(lo) <= n && n <= BigInt(hi))
      return Number(n);
  }
  return def;
}
function limits(root, environ) {
  const total = memTotal(root);
  if (!total)
    return null;
  return DEFAULTS.map(([prop, name, def, lo, hi]) => {
    const n = BigInt(envInt(environ, name, def, lo, hi));
    return [prop, prop === "CPUWeight" ? n : total * n / 100n];
  });
}
function controllersPath(uid) {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
}
function delegated(root, runtimeDir, uid) {
  const boot = pyStrip(read2(root, "/proc/sys/kernel/random/boot_id"));
  const cache = pyJoin(runtimeDir, "loadguard", "delegation");
  try {
    const cached = pySplit(read2("", cache));
    if (cached.length === 2 && cached[0] === boot && (cached[1] === "yes" || cached[1] === "no"))
      return cached[1] === "yes";
  } catch (e) {
    if (!(e instanceof PyError))
      throw e;
  }
  let yes;
  try {
    yes = pySplit(read2(root, controllersPath(uid))).includes("memory");
  } catch (e) {
    if (!(e instanceof PyError))
      throw e;
    return false;
  }
  try {
    makedirs(dirname(cache), 448);
    const tmp = `${cache}.${process.pid}`;
    writeFileSync(tmp, `${boot} ${yes ? "yes" : "no"}
`);
    renameSync(tmp, cache);
  } catch {}
  return yes;
}
function userName(uid) {
  const libc = loadLibc();
  if (libc !== null)
    return libc.userName(uid);
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split(`
`)) {
      const f = line.split(":");
      if (f.length >= 3 && f[2] === String(uid))
        return f[0];
    }
  } catch {}
  return null;
}
function lingering(root, user) {
  return user !== null && existsSync(root + "/var/lib/systemd/linger/" + user);
}
function ppid(root, pid) {
  const stat = read2(root, `/proc/${pid}/stat`);
  const close = stat.lastIndexOf(")");
  if (close < 0)
    throw new PyError("ValueError", "substring not found");
  const fields = pySplit(stat.slice(close + 2));
  if (fields.length < 2)
    throw new PyError("IndexError", "list index out of range");
  return pyInt(fields[1]);
}
function sessionName(root, pid) {
  try {
    const comm = pyStrip(read2(root, `/proc/${pid}/comm`));
    if (SESSION_NAMES.includes(comm))
      return comm;
    const name = basename(read2(root, `/proc/${pid}/cmdline`).split("\x00")[0]);
    return SESSION_NAMES.includes(name) ? name : null;
  } catch (e) {
    if (e instanceof PyError && e.kind === "OSError")
      return null;
    throw e;
  }
}
function findSession(root, start) {
  const chain = [];
  let pid = start;
  for (let i = 0;i < MAX_DEPTH; i++) {
    if (pid <= 1)
      break;
    if (sessionName(root, pid) !== null)
      return [pid, chain];
    chain.push(pid);
    pid = ppid(root, pid);
  }
  return [null, []];
}
function cgroup(root, pid) {
  for (const line of pySplitlines(read2(root, `/proc/${pid}/cgroup`)))
    if (line.startsWith("0::"))
      return line.slice(3);
  return null;
}
function inLoadguardScope(path) {
  return path.split("/").some((p) => p.startsWith(PREFIX) && p.endsWith(".scope"));
}
function descendants(root, pid) {
  let names;
  try {
    names = readdirSync(root + "/proc");
  } catch (e) {
    throw new PyError("OSError", String(e));
  }
  const children = new Map;
  for (const name of names) {
    if (!/^[0-9]+$/.test(name))
      continue;
    try {
      const child = pyInt(name), parent = ppid(root, child);
      const list = children.get(parent);
      if (list === undefined)
        children.set(parent, [child]);
      else
        list.push(child);
    } catch (e) {
      if (!(e instanceof PyError) || e.kind === "IndexError")
        throw e;
    }
  }
  const out = [], todo = [pid];
  while (todo.length > 0) {
    for (const child of children.get(todo.pop()) ?? []) {
      out.push(child);
      todo.push(child);
    }
  }
  return out;
}
function scopeName(sessionId, pid) {
  const short = (sessionId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `${PREFIX}${short !== "" ? short + "-" : ""}${pid}.scope`;
}
function busctlArgv(busctl, name, pids, props, description) {
  const argv = [
    busctl,
    "--user",
    `--timeout=${BUSCTL_TIMEOUT_S}`,
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    name,
    "fail"
  ];
  const sv = [
    ["Description", "s", [description]],
    ["Slice", "s", [SLICE]],
    ["PIDs", "au", [String(pids.length), ...pids.map(String)]],
    ...props.map(([k, v]) => [k, "t", [String(v)]]),
    ["OOMPolicy", "s", ["continue"]],
    ["CollectMode", "s", ["inactive-or-failed"]],
    ["Delegate", "b", ["true"]]
  ];
  argv.push(String(sv.length));
  for (const [key, sig, value] of sv)
    argv.push(key, sig, ...value);
  argv.push("0");
  return argv;
}
function run(argv) {
  for (const a of argv)
    if (a.includes("\x00") || !wellFormed(a))
      throw new PyError("ValueError", "argument not passable");
  const r = Bun.spawnSync({
    cmd: argv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: (BUSCTL_TIMEOUT_S + 1) * 1000,
    killSignal: "SIGKILL"
  });
  if (r.exitedDueToTimeout)
    throw new PyError("OSError", "busctl timed out");
  return r.exitCode;
}
function startScope(busctl, name, pids, props, description) {
  return run(busctlArgv(busctl, name, pids, props, description)) === 0;
}
function attach(busctl, name, pids) {
  return run([
    busctl,
    "--user",
    `--timeout=${BUSCTL_TIMEOUT_S}`,
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "AttachProcessesToUnit",
    "ssau",
    name,
    "",
    String(pids.length),
    ...pids.map(String)
  ]) === 0;
}
function outside(root, pids, name) {
  const out = [];
  for (const pid of pids) {
    let path;
    try {
      path = cgroup(root, pid);
    } catch (e) {
      if (e instanceof PyError && e.kind === "OSError")
        continue;
      throw e;
    }
    if (path !== null && !path.endsWith("/" + name))
      out.push(pid);
  }
  return out;
}
function waitAttached(root, pid, name, confirmS = CONFIRM_S) {
  const deadline = performance.now() + confirmS * 1000;
  for (;; ) {
    const path = cgroup(root, pid);
    if (path !== null && path.endsWith("/" + name))
      return true;
    if (performance.now() >= deadline)
      return false;
    Bun.sleepSync(10);
  }
}
function userBus(environ) {
  const runtimeDir = environ["XDG_RUNTIME_DIR"] ?? "";
  return runtimeDir.startsWith("/") && existsSync(pyJoin(runtimeDir, "bus")) ? runtimeDir : null;
}
function findBusctl(environ) {
  const path = environ["PATH"] ?? "";
  if (path === "")
    return null;
  const seen = new Set;
  for (const dir of path.split(":")) {
    if (seen.has(dir))
      continue;
    seen.add(dir);
    const name = pyJoin(dir, "busctl");
    try {
      accessSync(name, constants.X_OK);
      if (!statSync(name).isDirectory())
        return name;
    } catch {}
  }
  return null;
}
function confine(sessionId, host = {}) {
  const root = host.root ?? "", environ = host.environ ?? process.env;
  const uid = host.uid ?? process.getuid?.() ?? -1;
  const start = host.start ?? process.ppid, me = host.me ?? process.pid;
  if (environ["LOADGUARD_CONFINE"] === "0")
    return "disabled";
  const [pid, chain] = findSession(root, start);
  if (pid === null)
    return "no-session";
  const path = cgroup(root, pid);
  if (path === null)
    return "no-cgroup-v2";
  if (inLoadguardScope(path))
    return "already";
  if (!lingering(root, host.user !== undefined ? host.user : userName(uid)))
    return "no-linger";
  const runtimeDir = userBus(environ);
  if (runtimeDir === null)
    return "no-bus";
  const busctl = findBusctl(environ);
  if (busctl === null)
    return "no-busctl";
  if (!delegated(root, runtimeDir, uid))
    return "no-delegation";
  const props = limits(root, environ);
  if (props === null)
    return "no-meminfo";
  const name = scopeName(sessionId, pid);
  const description = `loadguard: ${sessionName(root, pid) ?? "None"} session ${sessionId || pid}`;
  if (!startScope(busctl, name, [pid], props, description))
    return "start-failed";
  if (!waitAttached(root, pid, name, host.confirmS ?? CONFIRM_S))
    return "unconfirmed";
  const others = outside(root, descendants(root, pid).filter((p) => !chain.includes(p) && p !== me), name);
  if (others.length > 0 && !attach(busctl, name, others))
    for (const other of others)
      attach(busctl, name, [other]);
  return "attached";
}
function scopeIn(path) {
  const name = (path ?? "").split("/").pop();
  return inLoadguardScope(name) ? name : null;
}
function owner(scope) {
  const m = /-([0-9]+)\.scope\n?$/.exec(scope);
  return m === null ? null : Number(m[1]);
}
function startWatcher(status, launch = {}) {
  const root = launch.root ?? "", environ = launch.environ ?? process.env;
  const start = launch.start ?? process.ppid;
  const entry = launch.entry ?? import.meta.dir + "/watch.js";
  if (environ["LOADGUARD_LEARN"] === "0")
    return "disabled";
  if (status !== "attached" && status !== "already")
    return "not-confined";
  try {
    accessSync(entry, constants.R_OK);
    if (!statSync(entry).isFile())
      return "no-entry";
  } catch {
    return "no-entry";
  }
  const [pid] = findSession(root, start);
  const scope = pid !== null && pid !== 0 ? scopeIn(cgroup(root, pid)) : null;
  if (scope === null || pid === null)
    return "not-confined";
  const env = { ...environ };
  for (const name of BUN_ENV_REMOVED)
    delete env[name];
  const child = spawn(launch.execPath ?? process.execPath, ["--no-install", "--config=/dev/null", "--no-env-file", entry, String(owner(scope) || pid)], { detached: true, stdio: "ignore", cwd: "/", env });
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined)
    return "spawn-failed";
  try {
    setPriority(child.pid, 10);
  } catch {}
  const busctl = findBusctl(environ);
  if (status === "attached" && busctl !== null)
    attach(busctl, scope, [child.pid]);
  return "started";
}

// ts/learnlist.ts
var FILE = "learned.jsonl";
var LOCK = "learned.lock";
var MAX_BYTES = 1 << 20;
var MAX_LINES = 256;

class ForgetError extends Error {
}
function strerror(e) {
  const errno = e.errno;
  const libc = typeof errno === "number" ? loadLibc() : null;
  if (libc !== null)
    return libc.strerror(Math.abs(errno));
  return e instanceof Error ? e.message : String(e);
}
function disabled(environ) {
  return environ["LOADGUARD_LEARN"] === "0";
}
function join(a, ...parts) {
  let out = a;
  for (const p of parts)
    out = p.startsWith("/") ? p : out === "" || out.endsWith("/") ? out + p : out + "/" + p;
  return out;
}
function dirname2(p) {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  return head !== "" && head !== "/".repeat(head.length) ? head.replace(/\/+$/, "") : head;
}
function stateDir(environ) {
  const xdg = environ["XDG_STATE_HOME"] ?? "", home = environ["HOME"] ?? "";
  if (xdg.startsWith("/"))
    return join(xdg, "loadguard");
  if (home.startsWith("/"))
    return join(home, ".local", "state", "loadguard");
  return null;
}
function listPath(environ) {
  const d = stateDir(environ);
  return d !== null ? join(d, FILE) : null;
}
function isEntry(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof v["command"] === "string";
}
function parse2(text) {
  const out = [];
  for (const line of text.split(`
`).slice(0, MAX_LINES)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isEntry(entry))
      out.push(entry);
  }
  return out;
}
function read3(path) {
  let fd;
  try {
    fd = openSync(path, constants2.O_RDONLY);
  } catch (e) {
    if (e.code === "ENOENT")
      return [[], null];
    return [[], strerror(e)];
  }
  const buf = Buffer.alloc(MAX_BYTES + 1);
  let n = 0;
  try {
    for (;; ) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0 || (n += got) === buf.length)
        break;
    }
  } catch (e) {
    return [[], strerror(e)];
  } finally {
    closeSync(fd);
  }
  if (n > MAX_BYTES)
    return [[], "too-large"];
  return [parse2(new TextDecoder("utf-8").decode(buf.subarray(0, n))), null];
}
function makedirs2(path, mode) {
  const head = dirname2(path);
  if (head !== "" && !path.endsWith("/") && !existsSync2(head))
    makedirs2(head, 511);
  try {
    mkdirSync2(path, { mode });
  } catch (e) {
    let dir = false;
    try {
      dir = statSync2(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir)
      throw e;
  }
}
function rewrite(path, entries) {
  if (entries.length === 0) {
    try {
      unlinkSync(path);
    } catch (e) {
      if (e.code !== "ENOENT")
        throw e;
    }
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      const data = Buffer.from(entries.map((e) => JSON.stringify(e) + `
`).join(""), "utf8");
      for (let n = 0;n < data.length; )
        n += writeSync(fd, data, n);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync2(tmp, path);
  } finally {
    if (existsSync2(tmp))
      unlinkSync(tmp);
  }
  const dir = openSync(dirname2(path), constants2.O_RDONLY | constants2.O_DIRECTORY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function forget(path, numbers) {
  makedirs2(dirname2(path), 448);
  const lock = openSync(join(dirname2(path), LOCK), "a");
  try {
    lockFile(lock, false);
    const [entries, problem] = read3(path);
    let dropped, kept;
    if (numbers === null) {
      [dropped, kept] = [entries, []];
    } else if (problem !== null) {
      throw new ForgetError(`the list cannot be read (${problem})`);
    } else {
      const bad = numbers.filter((n) => !(1 <= n && n <= entries.length));
      if (bad.length > 0)
        throw new ForgetError(`no entry ${bad[0]}: the list has ${entries.length}`);
      dropped = entries.filter((_e, i) => numbers.includes(i + 1));
      kept = entries.filter((_e, i) => !numbers.includes(i + 1));
    }
    rewrite(path, kept);
    return dropped;
  } finally {
    closeSync(lock);
  }
}
function watchFile(runtimeDir, scope) {
  return join(runtimeDir, "loadguard", scope + ".watch");
}
function isWatcher(argv) {
  if (argv.length > 2 && argv[1] === "--watch")
    return true;
  const i = argv.findIndex((a, n) => n > 0 && (a === "watch.js" || a.endsWith("/watch.js")));
  return i > 0 && /^[0-9]+$/.test(argv[i + 1] ?? "");
}
function watcher(environ, scope, procRoot = "") {
  const runtime = environ["XDG_RUNTIME_DIR"] ?? "";
  if (!runtime.startsWith("/") || scope === "")
    return null;
  let pid, argv;
  try {
    const raw = readFileSyncOrNull(watchFile(runtime, scope));
    if (raw === null || /[^\x00-\x7f]/.test(raw.toString("latin1")))
      return null;
    const first = pySplit(raw.toString("latin1").replace(/\r\n?/g, `
`))[0];
    if (first === undefined)
      return null;
    pid = pyInt(first);
    const cmdline = readFileSyncOrNull(`${procRoot}/proc/${pid}/cmdline`);
    if (cmdline === null)
      return null;
    argv = cmdline.toString("latin1").split("\x00");
  } catch {
    return null;
  }
  return isWatcher(argv) ? pid : null;
}
function readFileSyncOrNull(path) {
  try {
    return readFileSync2(path);
  } catch {
    return null;
  }
}

// ts/decide.ts
import { availableParallelism } from "os";

// ts/classify.ts
var LABEL_SIZE = 64;
var INTERPRETERS = ["perl", "python", "python3", "node", "sh", "bash", "dash"];
var CLAUDE_HEADLESS = ["-p", "--print", "--bg"];
var CODEX_HEADLESS = ["exec", "e", "review"];
function base(s) {
  const slash = s.lastIndexOf("/");
  return slash < 0 ? s : s.slice(slash + 1);
}
function subcommand(av) {
  for (let i = 1;i < av.length; i++) {
    const a = av[i];
    if (a[0] !== "-" && a[0] !== "+")
      return a;
  }
  return "";
}
function classify(argv) {
  let at = 0;
  if (argv.length < 1)
    return null;
  if (INTERPRETERS.includes(base(argv[0]))) {
    for (at = 1;at < argv.length && argv[at][0] === "-"; at++) {
      const a = argv[at];
      if (a === "-c" || a === "-e" || a === "-E")
        return null;
    }
    if (at === argv.length)
      return null;
  }
  const av = argv.slice(at);
  const name = base(av[0]);
  let sub = subcommand(av);
  let kind = 0 /* NONE */;
  if (name === "prove") {
    kind = 1 /* PROVE */;
    sub = "";
  } else if (name === "cpanm" || name === "perlbench") {
    kind = 3 /* BUILD */;
    sub = "";
  } else if (name === "dzil") {
    if (sub === "build")
      kind = 3 /* BUILD */;
    else if (sub === "test" || sub === "release")
      kind = 2 /* SUITE */;
  } else if (name === "make") {
    if (av.slice(1).includes("test")) {
      kind = 2 /* SUITE */;
      sub = "test";
    }
  } else if (name === "docker" || name === "podman") {
    if (sub === "build" || sub === "run")
      kind = 3 /* BUILD */;
  } else if (name === "cargo") {
    if (sub === "build")
      kind = 3 /* BUILD */;
    else if (sub === "test")
      kind = 2 /* SUITE */;
  } else if (name === "npm") {
    if (sub === "test")
      kind = 2 /* SUITE */;
  } else if (name === "claude" || name === "codex") {
    const headless = name === "claude" ? CLAUDE_HEADLESS : CODEX_HEADLESS;
    const word = av.slice(1).find((a) => headless.includes(a));
    if (word !== undefined) {
      kind = 4 /* AGENT */;
      sub = word;
    }
  }
  if (kind === 0 /* NONE */)
    return null;
  return { kind, at, label: fit(name + (sub !== "" ? " " + sub : ""), LABEL_SIZE) };
}
var MAX_WORDS = 32;
var WORD_MAX = 256;
var MAX_HEREDOCS = 8;
var DELIM_MAX = 64;
var PREFIXES = [
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "time",
  "exec",
  "nice",
  "ionice",
  "nohup",
  "timeout",
  "env",
  "stdbuf",
  "setsid",
  "xargs"
];
function assignment(w) {
  let i = 0;
  if (!isAlpha(w[0]) && w[0] !== "_")
    return false;
  while (isAlpha(w[i]) || isDigit(w[i]) || w[i] === "_")
    i++;
  return w[i] === "=" || w[i] === "+" && w[i + 1] === "=";
}

class Words {
  w = [];
  cur = "";
  open = false;
  skip = false;
  begin() {
    if (!this.open) {
      this.open = true;
      this.cur = "";
    }
  }
  put(c) {
    this.begin();
    if (this.w.length < MAX_WORDS && this.cur.length < WORD_MAX - 1)
      this.cur += c;
  }
  endWord() {
    if (!this.open)
      return;
    this.open = false;
    if (this.skip)
      this.skip = false;
    else if (this.w.length < MAX_WORDS)
      this.w.push(this.cur);
  }
  endCommand() {
    this.endWord();
    this.skip = false;
    let i = 0, prefixed = false;
    for (;i < this.w.length; i++) {
      const w = this.w[i];
      if (assignment(w))
        continue;
      if (prefixed && (w[0] === "-" || isDigit(w[0])))
        continue;
      if (PREFIXES.includes(w)) {
        prefixed = true;
        continue;
      }
      break;
    }
    const m = classify(this.w.slice(i));
    this.w = [];
    return m;
  }
}
function at(s, i) {
  return i < s.length ? s[i] : "\x00";
}
function heredocStart(s, p) {
  let delim = "", quote = "", strip = false;
  p += 2;
  if (at(s, p) === "-") {
    strip = true;
    p++;
  }
  while (at(s, p) === " " || at(s, p) === "\t")
    p++;
  for (;at(s, p) !== "\x00"; p++) {
    const c = at(s, p);
    if (quote !== "") {
      if (c === quote)
        quote = "";
      else if (delim.length < DELIM_MAX - 1)
        delim += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\" && at(s, p + 1) !== "\x00")
      p++;
    else if (" \t\n;&|()<>`".includes(c))
      break;
    if (delim.length < DELIM_MAX - 1)
      delim += at(s, p);
  }
  return { delim, strip, last: p - 1 };
}
function skipHeredocs(s, p, docs) {
  for (const doc of docs) {
    for (;; ) {
      if (at(s, p) !== `
`)
        return -1;
      let line = p + 1;
      let end = s.indexOf(`
`, line);
      if (end < 0)
        end = s.length;
      p = end;
      if (doc.strip)
        while (at(s, line) === "\t")
          line++;
      if (end - line === doc.delim.length && s.startsWith(doc.delim, line))
        break;
    }
  }
  return p;
}
function heavyCommand(cmd) {
  const s = new Words;
  const docs = [];
  let q = "plain";
  for (let p = 0;p < cmd.length; p++) {
    const c = cmd[p];
    if (q === "single") {
      if (c === "'")
        q = "plain";
      else
        s.put(c);
      continue;
    }
    if (q === "double") {
      if (c === '"') {
        q = "plain";
      } else if (c === "\\" && at(cmd, p + 1) !== "\x00" && '"\\$`\n'.includes(at(cmd, p + 1))) {
        if (at(cmd, p + 1) !== `
`)
          s.put(at(cmd, p + 1));
        p++;
      } else {
        s.put(c);
      }
      continue;
    }
    let separator = false;
    switch (c) {
      case "'":
        q = "single";
        s.begin();
        break;
      case '"':
        q = "double";
        s.begin();
        break;
      case "\\":
        if (at(cmd, p + 1) === `
`)
          p++;
        else if (at(cmd, p + 1) !== "\x00")
          s.put(at(cmd, ++p));
        break;
      case " ":
      case "\t":
      case "\r":
        s.endWord();
        break;
      case "#":
        if (s.open) {
          s.put(c);
          break;
        }
        while (at(cmd, p + 1) !== "\x00" && at(cmd, p + 1) !== `
`)
          p++;
        break;
      case "<":
      case ">":
        if (c === "<" && at(cmd, p + 1) === "<" && at(cmd, p + 2) !== "<") {
          s.endWord();
          const doc = heredocStart(cmd, p);
          if (docs.length < MAX_HEREDOCS && doc.delim !== "")
            docs.push(doc);
          p = doc.last;
          break;
        }
        s.endWord();
        while ("<>&|".includes(at(cmd, p + 1)) && at(cmd, p + 1) !== "\x00")
          p++;
        s.skip = true;
        break;
      case "&":
        if (at(cmd, p + 1) === ">") {
          s.endWord();
          while (at(cmd, p + 1) === ">")
            p++;
          s.skip = true;
          break;
        }
        separator = true;
        break;
      case `
`:
      case ";":
      case "|":
      case "(":
      case ")":
      case "`":
        separator = true;
        break;
      default:
        s.put(c);
    }
    if (separator) {
      const m = s.endCommand();
      if (m !== null)
        return m;
      if (c === `
` && docs.length > 0) {
        p = skipHeredocs(cmd, p, docs);
        docs.length = 0;
        if (p < 0 || p >= cmd.length)
          return null;
      }
    }
  }
  return s.endCommand();
}
var SHELLS = ["bash", "sh", "dash", "zsh"];
function claudeEval(s) {
  let p = s.indexOf("eval ");
  while (p > 0 && s[p - 1] !== " ")
    p = s.indexOf("eval ", p + 1);
  if (p < 0)
    return null;
  let out = "";
  for (p += 5;at(s, p) !== "\x00" && at(s, p) !== " "; ) {
    const c = at(s, p);
    if (c === "'") {
      const q = s.indexOf("'", p + 1);
      if (q < 0)
        return null;
      out += s.slice(p + 1, q);
      p = q + 1;
    } else if (c === '"') {
      for (p++;at(s, p) !== '"'; p++) {
        const d = at(s, p);
        if (d === "\x00" || d === "$" || d === "`")
          return null;
        if (d === "\\" && at(s, p + 1) !== "\x00" && '"\\$`\n'.includes(at(s, p + 1))) {
          p++;
          if (at(s, p) === `
`)
            continue;
        }
        out += at(s, p);
      }
      p++;
    } else if (c === "\\" && at(s, p + 1) !== "\x00") {
      if (at(s, p + 1) !== `
`)
        out += at(s, p + 1);
      p += 2;
    } else {
      return null;
    }
  }
  if (s.startsWith(" < /dev/null", p))
    p += 12;
  if (!s.startsWith(" && pwd -P >| ", p))
    return null;
  p += 14;
  let q = p;
  while (q < s.length && !` 	
'"\\$\`;&|<>()`.includes(s[q]))
    q++;
  return q === s.length && q - p > 4 && s.endsWith("-cwd") ? out : null;
}
function shellCommand(av, h) {
  if (av.length < 3 || !SHELLS.includes(base(av[0])) || av[1] !== "-c" && av[1] !== "-lc")
    return null;
  let cmd = null;
  if (h !== 2 /* CODEX */)
    cmd = claudeEval(av[2]);
  if (cmd === null && h !== 1 /* CLAUDE */)
    cmd = av[2];
  return cmd;
}
function splitArgv(buf, max) {
  const av = [];
  for (let p = 0;p < buf.length && av.length < max; ) {
    let end = buf.indexOf("\x00", p);
    if (end < 0)
      end = buf.length;
    av.push(buf.slice(p, end));
    p = end + 1;
  }
  while (av.length > 1 && av[av.length - 1] === "")
    av.pop();
  return av;
}

// ts/env.ts
function getenv(name) {
  const v = process.env[name];
  return v === undefined ? null : utf8Bytes(v);
}

// ts/learned.ts
import { closeSync as closeSync3, constants as constants4, fstatSync, openSync as openSync3, readSync as readSync3 } from "fs";

// ts/measure.ts
import { closeSync as closeSync2, constants as constants3, openSync as openSync2, readdirSync as readdirSync2, readSync as readSync2 } from "fs";
var PATH_MAX = 4096;
function slurp(root, path, size) {
  const full = root + path;
  if (full.length >= PATH_MAX)
    return null;
  let fd;
  try {
    fd = openSync2(pathOf(full), constants3.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(size - 1);
    let total = 0;
    while (total < size - 1) {
      const r = readSync2(fd, buf, total, size - 1 - total, null);
      if (r === 0)
        break;
      total += r;
    }
    return fromBuffer(buf.subarray(0, total));
  } catch {
    return null;
  } finally {
    closeSync2(fd);
  }
}
function listDir(root, path) {
  const full = root + path;
  if (full.length >= PATH_MAX)
    return null;
  try {
    return readdirSync2(pathOf(full), { encoding: "buffer" }).map((name) => fromBuffer(name));
  } catch {
    return null;
  }
}
function meminfo(buf, key) {
  for (let p = buf.indexOf(key);p >= 0; p = buf.indexOf(key, p + key.length))
    if (p === 0 || buf[p - 1] === `
`)
      return number(buf, p + key.length);
  return null;
}
function avg10(buf, key) {
  const p = buf.indexOf(key);
  if (p < 0)
    return -1;
  const [v, end] = strtod(buf, p + key.length);
  return end !== p + key.length && v >= 0 && v <= 100 ? v : -1;
}
function readPressure(root) {
  const pr = { full: -1, swap: -1 };
  let buf = slurp(root, "/proc/pressure/memory", 8192);
  if (buf !== null && buf.length > 0)
    pr.full = avg10(cstr(buf), "full avg10=");
  buf = slurp(root, "/proc/meminfo", 8192);
  if (buf !== null && buf.length > 0) {
    const text = cstr(buf);
    const total = meminfo(text, "SwapTotal:");
    const avail = total === null ? null : meminfo(text, "SwapFree:");
    if (total !== null && avail !== null && total > 0n && avail <= total)
      pr.swap = int32(u64((total - avail) * 100n) / total);
  }
  return pr;
}
function psiSome(root) {
  const buf = slurp(root, "/proc/pressure/memory", 8192);
  return buf !== null && buf.length > 0 ? avg10(cstr(buf), "some avg10=") : -1;
}
function zramFill(root) {
  if ((root + "/sys/block").length >= PATH_MAX)
    return -1;
  const names = listDir(root, "/sys/block");
  if (names === null)
    return -1;
  let size = 0n, data = 0n;
  for (const name of names) {
    if (!name.startsWith("zram"))
      continue;
    let buf = slurp(root, "/sys/block/" + name + "/disksize", 256);
    const s = buf !== null && buf.length > 0 ? number(cstr(buf)) : null;
    if (s === null || s === 0n)
      continue;
    buf = slurp(root, "/sys/block/" + name + "/mm_stat", 256);
    const d = buf !== null && buf.length > 0 ? number(cstr(buf)) : null;
    if (d === null)
      continue;
    size = u64(size + s);
    data = u64(data + d);
  }
  return size !== 0n ? int32(u64(data * 100n) / size) : -1;
}

// ts/learned.ts
var LEARNED_FILE = "learned.jsonl";
var LEARNED_BYTES = 1 << 20;
var LEARNED_LINES = 256;
function learnOff() {
  return getenv("LOADGUARD_LEARN") === "0";
}
function stateFile(name) {
  const xdg = getenv("XDG_STATE_HOME"), home = getenv("HOME");
  let path;
  if (xdg !== null && xdg[0] === "/")
    path = xdg + "/loadguard/" + name;
  else if (home !== null && home[0] === "/")
    path = home + "/.local/state/loadguard/" + name;
  else
    return null;
  return path.length < PATH_MAX ? path : null;
}
function readRegular(path, max) {
  let fd;
  try {
    fd = openSync3(pathOf(path), constants4.O_RDONLY | constants4.O_NONBLOCK | constants4.O_NOCTTY);
  } catch (e) {
    return { buf: null, state: e.code === "ENOENT" ? "none" : "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      return { buf: null, state: "unreadable" };
    if (st.size > max)
      return { buf: null, state: "too-large" };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = readSync3(fd, buf, n, st.size - n, null);
      if (r === 0)
        break;
      n += r;
    }
    return { buf: fromBuffer(buf.subarray(0, n)), state: "ok" };
  } catch {
    return { buf: null, state: "unreadable" };
  } finally {
    closeSync3(fd);
  }
}
function parseLessonObject(line) {
  const r = parse(line, line.length, false);
  if (r === null)
    return null;
  let end = r.end;
  while (end < line.length && isSpace(line[end]))
    end++;
  if (end !== line.length || r.value.t !== "obj" || str(get(r.value, "command")) === null)
    return null;
  return r.value;
}
function lessonObjects(buf) {
  const out = [];
  let lines = 0;
  for (let line = 0;line < buf.length && lines < LEARNED_LINES; lines++) {
    let end = buf.indexOf(`
`, line);
    if (end < 0)
      end = buf.length;
    const o = parseLessonObject(buf.slice(line, end));
    if (o !== null)
      out.push(o);
    line = end + 1;
  }
  return out;
}
function parseLesson(o) {
  const command = str(get(o, "command"));
  const peak = get(o, "peak_rss"), last = str(get(o, "last_seen"));
  let date = "";
  if (last !== null && last.length >= 10) {
    let i = 0;
    for (;i < 10; i++)
      if (i === 4 || i === 7 ? last[i] !== "-" : !isDigit(last[i]))
        break;
    if (i === 10)
      date = last.slice(0, 10);
  }
  return { command, peak: peak !== null && peak.t === "num" && peak.v > 0 ? peak.v : -1, last: date };
}
var loaded = null;
function loadLessons() {
  if (loaded !== null)
    return loaded;
  loaded = { state: "off", lessons: [] };
  if (learnOff())
    return loaded;
  loaded.state = "none";
  const path = stateFile(LEARNED_FILE);
  if (path === null)
    return loaded;
  const { buf, state } = readRegular(path, LEARNED_BYTES);
  loaded.state = state;
  if (buf === null)
    return loaded;
  for (const o of lessonObjects(buf))
    loaded.lessons.push(parseLesson(o));
  return loaded;
}
function learnedFile() {
  return stateFile(LEARNED_FILE);
}
function lessonFor(command) {
  return loadLessons().lessons.find((l) => l.command === command) ?? null;
}
function humanSize(bytes) {
  return bytes >= 1073741824 ? fixed(bytes / 1073741824, 1) + " GiB" : fixed(bytes / 1048576, 0) + " MiB";
}
function lessonLabel(ls, size) {
  let label = fit("learned", size);
  if (ls.peak > 0)
    label += fit(": peaked at " + fit(humanSize(ls.peak), 32) + " RSS", size - label.length);
  if (ls.last !== "")
    label += fit(" on " + ls.last, size - label.length);
  return label;
}
function cut(s, size) {
  if (s.length < size)
    return s;
  let n = size - 4;
  while (n > 0 && (s.charCodeAt(n) & 192) === 128)
    n--;
  return s.slice(0, n) + "...";
}

// ts/payload.ts
var MAX_PAYLOAD = 8 << 20;
async function readAll(stream) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size <= MAX_PAYLOAD)
      parts.push(chunk);
  }
  if (size > MAX_PAYLOAD)
    return null;
  const buf = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    buf.set(part, at);
    at += part.length;
  }
  return buf;
}
function parsePayload(buf) {
  const text = fromBuffer(buf);
  if (!validUtf8(text))
    return null;
  return parse(text + "\x00", text.length + 1, true)?.value ?? null;
}
function bashToolInput(payload) {
  if (payload === null || payload.t !== "obj")
    return null;
  if (str(get(payload, "tool_name")) !== "Bash")
    return null;
  const input = get(payload, "tool_input");
  if (input === null || input.t !== "obj" || str(get(input, "command")) === null)
    return null;
  return input;
}
function bashCommand(payload) {
  return str(get(bashToolInput(payload), "command"));
}

// ts/slots.ts
import { readlinkSync } from "fs";
var SLICE2 = "app-loadguard.slice";
var SHOWN = 3;
var MAX_DEPTH2 = 64;
var LABEL_SIZE2 = 48;
var HOLDER_SIZE = 160;
var CMDLINE_SIZE = 1 << 16;
var INT_MAX2 = 2147483647;
function sanitize(s) {
  const utf8 = validUtf8(s);
  let out = "";
  for (let i = 0;i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 32 || c === 127 || c >= 128 && !utf8 ? "?" : s[i];
  }
  return out;
}
function readPpid(root, pid) {
  const raw = slurp(root, "/proc/" + pid + "/stat", 1024);
  if (raw === null || raw.length === 0)
    return null;
  const buf = cstr(raw);
  let p = buf.lastIndexOf(")");
  if (p < 0)
    return null;
  p++;
  while (isSpace(buf[p]))
    p++;
  if (p >= buf.length)
    return null;
  p++;
  while (isSpace(buf[p]))
    p++;
  const m = /^[+-]?[0-9]+/.exec(buf.slice(p));
  if (m === null)
    return null;
  let v = BigInt(m[0]);
  const LONG = 1n << 63n;
  if (v >= LONG)
    v = LONG - 1n;
  if (v < -LONG)
    v = -LONG;
  return Number(BigInt.asIntN(32, v));
}
function learnedShell(av) {
  if (loadLessons().lessons.length === 0)
    return null;
  const cmd = shellCommand(av, 0 /* ANY */);
  if (cmd === null || lessonFor(cmd) === null)
    return null;
  return cut(cmd, LABEL_SIZE2);
}
function processKind(root, pid) {
  const none = { kind: 0 /* NONE */, label: "" };
  const buf = slurp(root, "/proc/" + pid + "/cmdline", CMDLINE_SIZE);
  if (buf === null || buf.length === 0)
    return none;
  let av = splitArgv(buf, MAX_WORDS);
  if (av.length === 1 && av[0].includes(" "))
    av = av[0].split(" ").filter((w) => w !== "").slice(0, MAX_WORDS);
  const m = classify(av);
  if (m === null) {
    if (buf.length >= CMDLINE_SIZE - 1)
      return none;
    const label = learnedShell(av);
    return label === null ? none : { kind: 5 /* LEARNED */, label };
  }
  let label = fit(base(av[m.at]), LABEL_SIZE2);
  for (let i = m.at + 1;i < av.length; i++) {
    const arg = av[i];
    if (label.length + 1 + arg.length >= LABEL_SIZE2) {
      if (label.length + 4 < LABEL_SIZE2)
        label += " ...";
      break;
    }
    label += " " + arg;
  }
  return { kind: m.kind, label };
}
function holdsSlot(k) {
  return k !== 0 /* NONE */ && k !== 4 /* AGENT */;
}
function describe(root, p) {
  const path = root + "/proc/" + p.pid + "/cwd";
  let cwd = null;
  if (path.length < PATH_MAX) {
    try {
      cwd = fromBuffer(readlinkSync(pathOf(path), { encoding: "buffer" })).slice(0, PATH_MAX - 1);
    } catch {
      cwd = null;
    }
  }
  let out;
  if (cwd === null || cwd.length === 0) {
    out = fit(p.label, HOLDER_SIZE);
  } else {
    cwd = cstr(cwd);
    const home = getenv("HOME");
    const hl = home !== null ? cstr(home).length : 0;
    let where = cwd;
    if (home !== null && hl > 1 && cwd.startsWith(cstr(home)) && (cwd.length === hl || cwd[hl] === "/"))
      where = "~" + cwd.slice(hl);
    out = p.label + " in " + where;
    if (out.length >= HOLDER_SIZE)
      out = out.slice(0, HOLDER_SIZE - 4) + "...";
  }
  return sanitize(out);
}
function scanSlots(root) {
  const sl = { busy: 0, holders: [] };
  const names = listDir(root, "/proc");
  if (names === null)
    return sl;
  const ps = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name))
      continue;
    const big = BigInt(name);
    if (big <= 0n || big > BigInt(INT_MAX2))
      continue;
    const pid = Number(big);
    const cgroup = slurp(root, "/proc/" + pid + "/cgroup", 4096);
    if (cgroup === null || cgroup.length === 0 || !cstr(cgroup).includes("/" + SLICE2 + "/"))
      continue;
    const ppid = readPpid(root, pid);
    if (ppid === null)
      continue;
    ps.push({ pid, ppid, ...processKind(root, pid) });
  }
  ps.sort((a, b) => a.pid - b.pid);
  const byPid = new Map;
  for (const p of ps)
    if (!byPid.has(p.pid))
      byPid.set(p.pid, p);
  const heavyAbove = (p) => {
    for (let depth = 0;depth < MAX_DEPTH2; depth++) {
      const up = byPid.get(p.ppid);
      if (up === undefined)
        return false;
      if (holdsSlot(up.kind))
        return true;
      p = up;
    }
    return false;
  };
  for (const p of ps) {
    if (!holdsSlot(p.kind) || heavyAbove(p))
      continue;
    if (sl.holders.length < SHOWN)
      sl.holders.push(describe(root, p));
    sl.busy++;
  }
  return sl;
}

// ts/decide.ts
var PSI_FULL_DEFAULT = 10;
var SWAP_USED_DEFAULT = 90;
var LEARN_RSS_DEFAULT = 20;
var LIMITS = {
  psiFull: { env: "LOADGUARD_PSI_FULL", lo: 1, hi: 100 },
  swapUsed: { env: "LOADGUARD_SWAP_USED", lo: 1, hi: 100 },
  slots: { env: "LOADGUARD_HEAVY_SLOTS", lo: 1, hi: 4096 },
  learnRss: { env: "LOADGUARD_LEARN_RSS", lo: 1, hi: 100 }
};
function envInt2(name, def, lo, hi) {
  const s = getenv(name);
  if (s === null || !isDigit(s[0]))
    return def;
  let v = 0, i = 0;
  for (;isDigit(s[i]); i++)
    if ((v = v * 10 + (s.charCodeAt(i) - 48)) > hi)
      return def;
  if (s[i] === "%")
    i++;
  return i === s.length && v >= lo ? v : def;
}
function limit(which, def) {
  const l = LIMITS[which];
  return envInt2(l.env, def, l.lo, l.hi);
}
function throttleOff() {
  return getenv("LOADGUARD_THROTTLE") === "0";
}
function defaultSlots() {
  const n = availableParallelism();
  return n >= 2 ? Math.floor(n / 2) : 1;
}

class Text {
  size;
  t = "";
  constructor(size) {
    this.size = size;
  }
  add(s) {
    if (this.t.length + 1 >= this.size)
      return;
    this.t = (this.t + s).slice(0, this.size - 1);
  }
}
function pressureFigures(r, pr, c) {
  if (pr.full >= 0)
    r.add("memory pressure full=" + fixed(pr.full, 1) + "% (limit " + c.psiFull + "%)");
  else
    r.add("memory pressure n/a");
  if (pr.swap >= 0)
    r.add(", swap " + pr.swap + "% used (limit " + c.swapUsed + "%)");
}
function measures(r, root, pr, c) {
  const zram = zramFill(root);
  pressureFigures(r, pr, c);
  if (zram >= 0)
    r.add(", zram " + zram + "% full");
  r.add(`.
`);
}
function advice(r, m, slots) {
  r.add((slots ? "Wait for one to finish, then retry" : "Wait and retry later") + "; light commands (git status, ls, cat) still run.");
  switch (m.kind) {
    case 1 /* PROVE */:
      if (slots)
        r.add(" When you retry, run fewer tests: `prove -l t/foo.t` instead of `-r`.");
      break;
    case 2 /* SUITE */:
      if (slots)
        r.add(" When you retry, run a single test file instead of the whole suite.");
      break;
    case 4 /* AGENT */:
      r.add(" Do not start new `claude -p`/`claude --bg` or `codex exec`/`codex review` sessions now; do the work in this one.");
      break;
    default:
      break;
  }
}
function newVerdict() {
  return {
    off: false,
    m: null,
    pressured: false,
    scanned: false,
    c: { psiFull: 0, swapUsed: 0, slots: 0 },
    pr: { full: -1, swap: -1 },
    sl: { busy: 0, holders: [] }
  };
}
function underPressure(root, v) {
  v.c.psiFull = limit("psiFull", PSI_FULL_DEFAULT);
  v.c.swapUsed = limit("swapUsed", SWAP_USED_DEFAULT);
  v.pr = readPressure(root);
  v.scanned = false;
  v.pressured = v.pr.full >= v.c.psiFull || v.pr.swap >= v.c.swapUsed;
  return v.pressured;
}
function noRoom(root, v) {
  if (underPressure(root, v))
    return true;
  v.c.slots = limit("slots", defaultSlots());
  v.sl = scanSlots(root);
  v.scanned = true;
  return v.sl.busy >= v.c.slots;
}
function learnedCommand(command) {
  const ls = lessonFor(command);
  return ls === null ? null : { kind: 5 /* LEARNED */, at: 0, label: lessonLabel(ls, 64) };
}
function fromCodex(payload, event) {
  if (event !== "SessionStart")
    return str(get(payload, "turn_id")) !== null;
  const root = getenv("PLUGIN_ROOT"), claudeRoot = getenv("CLAUDE_PLUGIN_ROOT");
  return root !== null && claudeRoot !== null && root === claudeRoot;
}
var REASON_MAX = 1024;
function objection(root, command, codex, v) {
  v.m = null;
  v.pressured = v.scanned = false;
  v.off = throttleOff();
  if (v.off)
    return null;
  v.m = heavyCommand(command) ?? learnedCommand(command);
  if (v.m === null)
    return null;
  if (!noRoom(root, v))
    return null;
  const r = new Text(REASON_MAX);
  r.add("loadguard: heavy command refused (" + v.m.label + "): ");
  if (v.scanned) {
    r.add(v.sl.busy + "/" + v.c.slots + " heavy slots busy (");
    v.sl.holders.forEach((h, i) => r.add((i ? "; " : "") + h));
    if (v.sl.busy > v.sl.holders.length)
      r.add("; +" + (v.sl.busy - v.sl.holders.length) + " more");
    r.add("), ");
  }
  measures(r, root, v.pr, v.c);
  advice(r, v.m, v.scanned);
  return codex && r.t.endsWith(".") ? r.t.slice(0, -1) : r.t;
}
var CONTEXT_EVENTS = ["UserPromptSubmit", "SessionStart"];
function contextEvent(payload) {
  if (payload === null || payload.t !== "obj")
    return null;
  const name = str(get(payload, "hook_event_name"));
  return name !== null && CONTEXT_EVENTS.includes(name) ? name : null;
}
function situation(root, codex, v) {
  v.pressured = v.scanned = false;
  v.off = throttleOff();
  if (v.off || !underPressure(root, v))
    return null;
  const line = new Text(REASON_MAX);
  line.add("loadguard: ");
  pressureFigures(line, v.pr, v.c);
  line.add(". Heavy commands refused until it eases: prove, make test, builds, new claude -p/--bg. " + "Light commands still run" + (codex ? "" : "; see `loadguard status`") + ".");
  return line.t;
}
function respond(kv) {
  return print(jobj([["hookSpecificOutput", jobj(kv.map(([k, x]) => [k, jstr(x)]))]]));
}
function hook(root, payload) {
  const event = contextEvent(payload);
  const v = newVerdict();
  if (event !== null) {
    const line = situation(root, fromCodex(payload, event), v);
    return line === null ? "" : respond([["hookEventName", event], ["additionalContext", line]]);
  }
  const command = bashCommand(payload);
  if (command === null)
    return "";
  const reason = objection(root, command, fromCodex(payload, null), v);
  return reason === null ? "" : respond([
    ["hookEventName", "PreToolUse"],
    ["permissionDecision", "deny"],
    ["permissionDecisionReason", reason]
  ]);
}

// ts/report.ts
var REPORT_FORMAT = 1;
function percent(v) {
  return v >= 0 ? jnum(v) : jnull;
}
function reportStart(mode, off) {
  const ignored = [];
  if (getenv("LOADGUARD_THROTTLE") !== null && !off)
    ignored.push(jstr("LOADGUARD_THROTTLE"));
  for (const which of Object.keys(LIMITS))
    if (getenv(LIMITS[which].env) !== null && limit(which, -1) < 0)
      ignored.push(jstr(LIMITS[which].env));
  if (getenv("LOADGUARD_LEARN") !== null && !learnOff())
    ignored.push(jstr("LOADGUARD_LEARN"));
  return [["report", jnum(REPORT_FORMAT)], ["mode", jstr(mode)], ["throttle", jbool(!off)], ["ignored", jarr(ignored)]];
}
function putLearn(out) {
  const { state, lessons } = loadLessons();
  const file = learnedFile();
  out.push(["learn", jobj([
    ["on", jbool(!learnOff())],
    ["file", file === null ? jnull : jstr(file)],
    ["state", jstr(state)],
    ["entries", jnum(lessons.length)],
    ["rss_limit", jnum(limit("learnRss", LEARN_RSS_DEFAULT))]
  ])]);
}
function putRoom(out, root, v, slotLimit) {
  const limits = [["psi_full", jnum(v.c.psiFull)], ["swap_used", jnum(v.c.swapUsed)]];
  if (slotLimit)
    limits.push(["slots", jnum(v.c.slots)]);
  out.push(["limits", jobj(limits)]);
  out.push(["pressure", jobj([
    ["full", percent(v.pr.full)],
    ["some", percent(psiSome(root))],
    ["swap", percent(v.pr.swap)],
    ["zram", percent(zramFill(root))]
  ])]);
  out.push(["pressured", jbool(v.pressured)]);
  out.push(["slots", v.scanned ? jobj([["busy", jnum(v.sl.busy)], ["holders", jarr(v.sl.holders.map(jstr))]]) : jnull]);
}
function line(out) {
  return print(jobj(out)) + `
`;
}
function reportStatus(root) {
  const v = newVerdict();
  v.off = throttleOff();
  const full = noRoom(root, v);
  if (!v.scanned)
    v.c.slots = limit("slots", defaultSlots());
  const out = reportStart("status", v.off);
  putRoom(out, root, v, true);
  out.push(["refuse_heavy", jbool(!v.off && full)]);
  putLearn(out);
  return line(out);
}
function reportExplain(root, payload) {
  const command = bashCommand(payload);
  let reason = null;
  let out;
  if (command === null) {
    out = reportStart("explain", throttleOff());
    out.push(["bash", jbool(false)]);
  } else {
    const v = newVerdict();
    reason = objection(root, command, fromCodex(payload, null), v);
    out = reportStart("explain", v.off);
    out.push(["bash", jbool(true)]);
    out.push(["heavy", v.m === null ? jnull : jstr(v.m.label)]);
    if (!v.off && v.m !== null)
      putRoom(out, root, v, v.scanned);
  }
  out.push(["decision", jstr(reason !== null ? "deny" : "allow")]);
  out.push(["reason", reason === null ? jnull : jstr(reason)]);
  return line(out);
}

// ts/slot.ts
import { accessSync as accessSync2, constants as constants5, existsSync as existsSync3, lstatSync, readdirSync as readdirSync3, readFileSync as readFileSync3, statSync as statSync3 } from "fs";
// package.json
var package_default = {
  name: "loadguard",
  private: true,
  type: "module",
  gettyBun: {
    contractVersion: 1,
    bunVersion: "1.4.5"
  },
  scripts: {
    build: "bun build --target=bun --outdir=dist ts/driver.ts ts/confine.ts ts/watch.ts ts/cli.ts",
    "check-dist": "sh ts/check-dist.sh",
    typecheck: "tsc -p tsconfig.json",
    test: "bun test ./ts/test/"
  },
  devDependencies: {
    "@types/bun": "1.4.5",
    typescript: "7.0.2"
  }
};

// ts/slot.ts
var PIN = package_default.gettyBun.bunVersion;
function store(environ) {
  let home;
  const getty = environ["GETTY_HOME"];
  if (getty !== undefined) {
    if (!getty.startsWith("/"))
      return { error: `GETTY_HOME must be an absolute path, got '${getty}'` };
    home = getty;
  } else {
    const h = environ["HOME"] ?? "";
    if (!h.startsWith("/"))
      return { error: "HOME is not an absolute path; set GETTY_HOME to an absolute path" };
    home = h + "/.getty";
  }
  if (/[\x00-\x1f\x7f]/.test(home))
    return { error: "GETTY_HOME contains control characters" };
  while (home !== "/" && home.endsWith("/"))
    home = home.slice(0, -1);
  return { home };
}
function hasAvx2(root) {
  let text;
  try {
    text = readFileSync3(root + "/proc/cpuinfo", "latin1");
  } catch {
    return false;
  }
  for (const line of text.split(`
`))
    if (line.startsWith("flags") && line.includes(":"))
      return (" " + line.slice(line.indexOf(":") + 1) + " ").includes(" avx2 ");
  return false;
}
function target(root, platform, arch) {
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "aarch64" : arch;
  if (platform !== "linux")
    return { error: `unsupported target ${platform}-${a}` };
  const ld = a === "x64" ? "/lib64/ld-linux-x86-64.so.2" : a === "aarch64" ? "/lib/ld-linux-aarch64.so.1" : null;
  if (ld === null)
    return { error: `unsupported target linux-${a}` };
  if (!existsSync3(root + ld)) {
    let musl;
    try {
      musl = readdirSync3(root + "/lib").find((f) => /^ld-musl-.*\.so\.1$/.test(f));
    } catch {
      musl = undefined;
    }
    if (musl !== undefined)
      return { error: `unsupported target linux-${a}-musl (musl libc /lib/${musl}, no glibc ${ld})` };
  }
  return { target: a === "x64" && !hasAvx2(root) ? "linux-x64-baseline" : `linux-${a}` };
}
function state(slot, pin, tgt) {
  let present = existsSync3(slot);
  if (!present) {
    try {
      lstatSync(slot);
      present = true;
    } catch {
      present = false;
    }
  }
  if (!present)
    return "missing";
  try {
    const receipt = slot + "/receipt.json", bun = slot + "/bin/bun";
    if (!statSync3(receipt).isFile() || !statSync3(bun).isFile() || statSync3(bun).size === 0)
      return "mismatch";
    accessSync2(receipt, constants5.R_OK);
    accessSync2(bun, constants5.X_OK);
    const lines = readFileSync3(receipt, "utf8").split(`
`);
    return lines[0] === "{" && lines[1] === `  "version": "${pin}",` && lines[2] === `  "target": "${tgt}",` ? "ready" : "mismatch";
  } catch {
    return "mismatch";
  }
}
function findSlot(environ, root = "", platform = process.platform, arch = process.arch) {
  const s = store(environ);
  if ("error" in s)
    return s;
  const t = target(root, platform, arch);
  if ("error" in t)
    return t;
  const slot = `${s.home === "/" ? "" : s.home}/runtimes/bun/${PIN}/${t.target}`;
  return { slot, target: t.target, state: state(slot, PIN, t.target) };
}

// ts/commands.ts
var REPORT_FORMAT2 = 1;
var LABEL = 9;
function doc(bytes) {
  const d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(toBuffer(bytes)));
  if (typeof d !== "object" || d === null || d.report !== REPORT_FORMAT2)
    throw new Error("no report: " + bytes);
  return d;
}
function payload(command) {
  return jobj([
    ["hook_event_name", jstr("PreToolUse")],
    ["tool_name", jstr("Bash")],
    ["tool_input", jobj([["command", jstr(command)]])]
  ]);
}
var NONPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
function hex(c, n) {
  return c.toString(16).padStart(n, "0");
}
function backslash(c) {
  return c <= 255 ? "\\x" + hex(c, 2) : c <= 65535 ? "\\u" + hex(c, 4) : "\\U" + hex(c, 8);
}
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === q || ch === "\\")
      out += "\\" + ch;
    else if (ch === "\t")
      out += "\\t";
    else if (ch === `
`)
      out += "\\n";
    else if (ch === "\r")
      out += "\\r";
    else if (c < 32 || c === 127)
      out += "\\x" + hex(c, 2);
    else if (c > 127 && NONPRINTABLE.test(ch))
      out += backslash(c);
    else
      out += ch;
  }
  return out + q;
}
function d(n) {
  return String(Math.trunc(n));
}
function plural(n) {
  return n === 1 ? "" : "s";
}
function session(root, start) {
  try {
    const [pid] = findSession(root, start);
    return [pid, pid ? cgroup(root, pid) : null];
  } catch (e) {
    if (e instanceof PyError)
      return [null, null];
    throw e;
  }
}
function scopeOf(path) {
  for (const part of (path ?? "").split("/"))
    if (inLoadguardScope(part))
      return part;
  return null;
}
function sessionText(pid, path) {
  if (pid === null)
    return "not run from a Claude Code or Codex session";
  const scope = scopeOf(path);
  if (scope !== null)
    return "confined in " + scope;
  return `not confined (cgroup ${path ?? "n/a"})`;
}
function rows(label, lines) {
  return lines.map((line, i) => (i === 0 ? (label + ":").padEnd(LABEL) : " ".repeat(LABEL)) + line);
}
function percent2(value, digits = 0) {
  return value === null ? "n/a" : fixed(value, digits) + "%";
}
function memory(doc) {
  const { pressure: p, limits: lim } = doc;
  let text = `PSI full ${percent2(p.full, 2)} (limit ${d(lim.psi_full)}%), some ${percent2(p.some, 2)}; ` + `swap ${percent2(p.swap)} used (limit ${d(lim.swap_used)}%)`;
  if (p.zram !== null)
    text += `; zram ${d(p.zram)}% full`;
  return text;
}
function slotLines(doc) {
  const slots = doc.slots;
  if (slots === null)
    return [
      "not scanned: under memory pressure the hook reads no other",
      "process (that can stall on swap); pressure alone refuses"
    ];
  const lines = [`${d(slots.busy)}/${d(doc.limits.slots)} heavy busy`, ...slots.holders];
  if (slots.busy > slots.holders.length)
    lines.push(`+${d(slots.busy - slots.holders.length)} more`);
  return lines;
}
function ignoredLines(names, environ) {
  return names.map((name) => {
    const value = pyRepr(environ[name] ?? "");
    return ["LOADGUARD_THROTTLE", "LOADGUARD_CONFINE", "LOADGUARD_LEARN"].includes(name) ? `${name}=${value} changes nothing: only 0 turns it off` : `${name}=${value} is not valid: the default applies`;
  });
}
function heavyNow(doc) {
  if (!doc.throttle)
    return "never refused: LOADGUARD_THROTTLE=0";
  if (!doc.refuse_heavy)
    return "a heavy command would run now";
  return `a heavy command would be refused now (${doc.pressured ? "memory pressure" : "all heavy slots busy"})`;
}
function formatStatus(doc, environ, sessionLine, hookLine) {
  return [
    ...rows("memory", [memory(doc)]),
    ...rows("slots", slotLines(doc)),
    ...rows("heavy", [heavyNow(doc)]),
    ...rows("ignored", ignoredLines(doc.ignored, environ)),
    ...rows("session", [sessionLine]),
    ...rows("hook", [hookLine])
  ];
}
function formatExplain(doc, environ) {
  const lines = rows("ignored", ignoredLines(doc.ignored, environ));
  if (!doc.bash)
    return [...lines, ...rows("verdict", ["allow: not a Bash payload the hook can read; it passes it through"])];
  if (!doc.throttle) {
    lines.push(...rows("heavy", ["not checked: LOADGUARD_THROTTLE=0"]));
  } else if (doc.heavy === null) {
    lines.push(...rows("heavy", ["no: no heavy pattern, not learned; a light command is never refused"]));
  } else {
    lines.push(...rows("heavy", [`yes (${doc.heavy})`]), ...rows("memory", [memory(doc)]), ...rows("slots", slotLines(doc)));
  }
  if (doc.decision === "deny")
    return [...lines, ...rows("verdict", ["deny; the model is told:", ...(doc.reason ?? "").split(`
`)])];
  return [...lines, ...rows("verdict", ["allow: the hook stays silent, the command runs"])];
}
function status(c) {
  const here = sessionText(...session(c.root, c.start));
  const lines = formatStatus(doc(reportStatus(c.root)), c.environ, here, `decided in-process by ${c.self}, the hook's own code`);
  return { rc: 0, stdout: lines.join(`
`) + `
`, stderr: "" };
}
function explain(c, command) {
  const lines = formatExplain(doc(reportExplain(c.root, payload(command))), c.environ);
  return { rc: 0, stdout: lines.join(`
`) + `
`, stderr: "" };
}
function shown(text) {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (ch === "\\")
      out += "\\\\";
    else if (ch === `
`)
      out += "\\n";
    else if (ch === "\t")
      out += "\\t";
    else if (c < 32 || c === 127)
      out += "\\x" + hex(c, 2);
    else if (c < 128)
      out += ch;
    else
      out += backslash(c);
  }
  return out;
}
function homeShort(path, environ) {
  const home = environ["HOME"] ?? "";
  if (home.length > 1 && (path === home || path.startsWith(home + "/")))
    return "~" + path.slice(home.length);
  return path;
}
function size(n) {
  return n >= 2 ** 30 ? fixed(n / 2 ** 30, 1) + " GiB" : d(Math.floor(n / 2 ** 20)) + " MiB";
}
function entryLines(n, entry, environ) {
  const raw = entry["peak_rss"], peak = typeof raw === "boolean" ? Number(raw) : raw;
  const last = entry["last_seen"], cwd = entry["cwd"];
  let head = `${String(n).padStart(3)}  ${typeof peak === "number" && peak > 0 ? size(peak) : "? MiB"}  last ` + (typeof last === "string" ? shown(Array.from(last).slice(0, 10).join("")) : "?");
  if (typeof cwd === "string" && cwd !== "")
    head += "  in " + shown(homeShort(cwd, environ));
  return [head, "     " + shown(entry["command"])];
}
function learned(environ) {
  const path = listPath(environ);
  if (path === null)
    return { rc: 1, stdout: `learned: no list: neither $XDG_STATE_HOME nor $HOME is an absolute path
`, stderr: "" };
  const [entries, problem] = read3(path);
  const lines = [];
  if (disabled(environ))
    lines.push("learning is off (LOADGUARD_LEARN=0): the hook ignores this list");
  if (problem === "too-large") {
    lines.push(`${path} is larger than ${MAX_BYTES} bytes: the hook ignores it; \`loadguard forget all\` clears it`);
  } else if (problem !== null) {
    lines.push(`${path} cannot be read: ${problem}`);
  } else if (entries.length === 0) {
    lines.push(`no learned commands (${path})`);
  } else {
    lines.push(`${entries.length} learned command${plural(entries.length)} in ${path}; each exact text is heavy:`);
    entries.forEach((entry, i) => lines.push(...entryLines(i + 1, entry, environ)));
  }
  return { rc: problem !== null ? 1 : 0, stdout: lines.join(`
`) + `
`, stderr: "" };
}
function forget2(environ, args) {
  const path = listPath(environ);
  if (path === null)
    return { rc: 1, stdout: `forget: no list: neither $XDG_STATE_HOME nor $HOME is an absolute path
`, stderr: "" };
  let numbers;
  if (args.length === 1 && args[0] === "all")
    numbers = null;
  else if (args.every((a) => /^[1-9][0-9]{0,5}$/.test(a)))
    numbers = [...new Set(args.map(Number))].sort((a, b) => a - b);
  else
    return usage(2);
  let dropped;
  try {
    dropped = forget(path, numbers);
  } catch (e) {
    const text = e instanceof ForgetError ? e.message : strerror(e);
    return { rc: 1, stdout: `forget: ${text}; nothing changed
`, stderr: "" };
  }
  const lines = dropped.length === 0 ? [`nothing to forget (${path})`] : [];
  for (const entry of dropped)
    lines.push("forgot: " + shown(entry["command"]));
  return { rc: 0, stdout: lines.join(`
`) + `
`, stderr: "" };
}
function asOSError(f, otherwise) {
  try {
    return f();
  } catch (e) {
    if (e instanceof PyError && e.kind === "OSError")
      return otherwise;
    throw e;
  }
}
function confineIgnored(environ) {
  const names = [];
  if ("LOADGUARD_CONFINE" in environ && environ["LOADGUARD_CONFINE"] !== "0")
    names.push("LOADGUARD_CONFINE");
  for (const [, name, , lo, hi] of DEFAULTS)
    if (name in environ && envInt(environ, name, -1, lo, hi) === -1)
      names.push(name);
  return names;
}
function stage1(c) {
  const environ = c.environ, off = environ["LOADGUARD_CONFINE"] === "0";
  const bad = off ? "--" : "FAIL";
  const out = [];
  const v2 = asOSError(() => cgroup(c.root, c.me) !== null, false);
  out.push(v2 ? ["ok", "cgroup v2", null] : [bad, "no cgroup v2", "confinement needs the unified hierarchy"]);
  const runtimeDir = userBus(environ), busctl = findBusctl(environ);
  out.push(runtimeDir !== null && busctl !== null ? ["ok", `user bus in ${runtimeDir}, ${busctl}`, null] : [
    bad,
    runtimeDir === null ? "no user bus ($XDG_RUNTIME_DIR/bus)" : "no busctl on PATH",
    "confinement talks to systemd --user"
  ]);
  let isDelegated = false;
  if (runtimeDir !== null) {
    isDelegated = asOSError(() => delegated(c.root, runtimeDir, c.uid), false);
    out.push(isDelegated ? ["ok", `memory controller delegated to user@${c.uid}.service`, null] : [bad, `memory controller not delegated to user@${c.uid}.service`, "see " + controllersPath(c.uid)]);
  } else {
    out.push(["--", "delegation not checked without a user bus", null]);
  }
  const name = userName(c.uid);
  const user = name ?? String(c.uid);
  const linger = lingering(c.root, name);
  out.push(linger ? ["ok", "linger for " + user, null] : [bad, "no linger for " + user, "loginctl enable-linger; without it sessions stay unconfined"]);
  const lim = asOSError(() => limits(c.root, environ), null);
  if (lim !== null) {
    out.push(["ok", "limits " + lim.map(([k, v]) => `${k} ${k === "CPUWeight" ? String(v) : size(Number(v))}`).join(", "), null]);
  } else {
    out.push([bad, "no MemTotal in /proc/meminfo", null]);
  }
  const works = v2 && runtimeDir !== null && busctl !== null && isDelegated && linger && lim !== null;
  const [pid, path] = session(c.root, c.start);
  if (pid === null || scopeOf(path) !== null) {
    out.push([pid ? "ok" : "--", "this session: " + sessionText(pid, path), null]);
  } else {
    out.push([
      works && !off ? "FAIL" : "--",
      "this session: " + sessionText(pid, path),
      works && !off ? "sessions are confined when they start; start a new one" : null
    ]);
  }
  return ["stage 1, confine sessions: " + (off ? "off (LOADGUARD_CONFINE=0)" : works ? "on" : "cannot work here"), out];
}
function stage23(rep) {
  if (!rep.throttle)
    return ["stage 2/3, refuse heavy commands: off (LOADGUARD_THROTTLE=0)", []];
  const lim = rep.limits;
  return ["stage 2/3, refuse heavy commands: on", [[
    "ok",
    `limits memory PSI full ${d(lim.psi_full)}%, swap ${d(lim.swap_used)}% used, ${d(lim.slots)} heavy slots`,
    null
  ]]];
}
function learning(c, rep) {
  const lrn = rep.learn;
  if (!lrn.on)
    return ["learning, heavy by what ran: off (LOADGUARD_LEARN=0)", [["--", "no watcher, the list is ignored", null]]];
  const out = [];
  const where = lrn.file;
  if (where === null) {
    out.push(["FAIL", "no list: neither $XDG_STATE_HOME nor $HOME is an absolute path", null]);
  } else if (lrn.state === "ok") {
    out.push(["ok", `${d(lrn.entries)} learned command${plural(lrn.entries)} in ${where}`, null]);
  } else if (lrn.state === "none") {
    out.push(["ok", `no learned commands yet (${where})`, null]);
  } else {
    out.push([
      "FAIL",
      `${where} is ${lrn.state === "too-large" ? "too large" : "unreadable"}: the hook ignores it`,
      "loadguard forget all"
    ]);
  }
  const total = asOSError(() => memTotal(c.root), null);
  out.push(["ok", `a command is learned at ${d(lrn.rss_limit)}% of MemTotal` + (total ? ` (${size(Number(total * BigInt(lrn.rss_limit) / 100n))})` : ""), null]);
  const scope = scopeOf(session(c.root, c.start)[1]);
  if (scope === null) {
    out.push(["--", "no watcher: this session is not confined", null]);
  } else {
    const found = watcher(c.environ, scope, c.root);
    out.push(found ? ["ok", `watcher of this session: pid ${found}`, null] : ["FAIL", "no watcher for this session", "it starts with the session; start a new session"]);
  }
  return ["learning, heavy by what ran: on", out];
}
function runtime(c) {
  const out = [];
  const running = process.versions.bun ?? "none";
  out.push(running === PIN ? ["ok", `this runs on Bun ${running}, the pin, at ${process.execPath}`, null] : [
    "FAIL",
    `this runs on Bun ${running}, the pin is ${PIN} (${process.execPath})`,
    `the getty-bun starter runs Bun ${PIN}`
  ]);
  const slot = findSlot(c.environ, c.root);
  let state;
  if ("error" in slot) {
    state = "cannot work here";
    out.push(["FAIL", "no getty-bun slot: " + slot.error, "the starter fails the same way"]);
  } else {
    state = slot.state;
    if (slot.state === "ready")
      out.push(["ok", `getty-bun slot ${slot.slot} ready`, null]);
    else if (slot.state === "missing")
      out.push(["--", `no getty-bun slot yet at ${slot.slot}`, "the first hook installs Bun there (one download)"]);
    else
      out.push([
        "FAIL",
        `getty-bun slot ${slot.slot} does not match the pin ${PIN} ${slot.target}`,
        "remove that directory; the next hook installs it again"
      ]);
  }
  return [`runtime, Bun ${PIN} from getty-bun: ${state}`, out];
}
function doctorSections(c) {
  const rep = doc(reportStatus(c.root));
  const sections = [stage1(c), stage23(rep), learning(c, rep), runtime(c)];
  const names = [...rep.ignored, ...confineIgnored(c.environ)];
  if (names.length > 0)
    sections.push(["environment", ignoredLines(names, c.environ).map((line) => ["FAIL", line, null])]);
  return sections;
}
function doctor(c) {
  const lines = ["loadguard doctor"];
  let fails = 0;
  for (const [title, checks] of doctorSections(c)) {
    lines.push(title);
    for (const [state, text, hint] of checks) {
      if (state === "FAIL")
        fails++;
      lines.push(`  ${state.padEnd(4)}  ${text}`);
      if (hint !== null)
        lines.push("        -> " + hint);
    }
  }
  lines.push(fails === 0 ? "all good" : `${fails} problem${plural(fails)}`);
  return { rc: fails ? 1 : 0, stdout: lines.join(`
`) + `
`, stderr: "" };
}
var USAGE = `usage: loadguard status | doctor | explain '<command>' | learned
                 | forget <n>... | forget all | help
  status    memory pressure, heavy slots and who holds them, as the hook
            sees them
  doctor    can loadguard work here? exit 1 if something is broken
  explain   what the hook would do with this Bash command now (dry run);
            without a command it reads one from stdin, the way to pass
            a command that starts with -
  learned   commands that once took a lot of memory: their exact text is
            heavy from then on
  forget    drop learned commands by their number in \`learned\`, or all
  help      this text`;
function usage(rc) {
  return rc === 0 ? { rc, stdout: USAGE + `
`, stderr: "" } : { rc, stdout: "", stderr: USAGE + `
` };
}
function fromStdin(raw) {
  const s = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1");
  return s.endsWith(`
`) ? s.slice(0, -1) : s;
}
async function main(args, stdin, where = {}) {
  const c = {
    root: where.root ?? "",
    uid: where.uid ?? process.getuid?.() ?? -1,
    me: where.me ?? process.pid,
    start: where.start ?? process.ppid,
    self: where.self ?? import.meta.path,
    environ: process.env
  };
  const [cmd, ...rest] = args;
  if (cmd === "help")
    return usage(0);
  if (cmd === "status" && rest.length === 0)
    return status(c);
  if (cmd === "doctor" && rest.length === 0)
    return doctor(c);
  if (cmd === "explain" && rest.length === 0) {
    const command = fromStdin(await stdin());
    return command === "" ? usage(2) : explain(c, command);
  }
  if (cmd === "explain" && !rest[0].startsWith("-"))
    return explain(c, utf8Bytes(rest.join(" ")));
  if (cmd === "learned" && rest.length === 0)
    return learned(c.environ);
  if (cmd === "forget" && rest.length > 0)
    return forget2(c.environ, rest);
  return usage(2);
}

// ts/cli.ts
var rc = 1;
try {
  const r = await main(process.argv.slice(2), async () => new Uint8Array(await Bun.stdin.arrayBuffer()));
  if (r.stdout !== "")
    await Bun.write(Bun.stdout, r.stdout);
  if (r.stderr !== "")
    await Bun.write(Bun.stderr, r.stderr);
  rc = r.rc;
} catch (e) {
  await Bun.write(Bun.stderr, `loadguard: ${e instanceof Error ? e.message : String(e)}
`);
}
process.exit(rc);
