// @bun
// ts/watcher.ts
import { closeSync as closeSync3, fsyncSync, ftruncateSync, mkdirSync, openSync as openSync3, readFileSync, readlinkSync as readlinkSync2, renameSync, unlinkSync, writeSync, constants as constants3 } from "fs";
import { setPriority } from "os";

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

// ts/decide.ts
import { availableParallelism } from "os";

// ts/env.ts
function getenv(name) {
  const v = process.env[name];
  return v === undefined ? null : utf8Bytes(v);
}

// ts/learned.ts
import { closeSync as closeSync2, constants as constants2, fstatSync, openSync as openSync2, readSync as readSync2 } from "fs";

// ts/measure.ts
import { closeSync, constants, openSync, readdirSync, readSync } from "fs";
var PATH_MAX = 4096;
function slurp(root, path, size) {
  const full = root + path;
  if (full.length >= PATH_MAX)
    return null;
  let fd;
  try {
    fd = openSync(pathOf(full), constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(size - 1);
    let total = 0;
    while (total < size - 1) {
      const r = readSync(fd, buf, total, size - 1 - total, null);
      if (r === 0)
        break;
      total += r;
    }
    return fromBuffer(buf.subarray(0, total));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
function listDir(root, path) {
  const full = root + path;
  if (full.length >= PATH_MAX)
    return null;
  try {
    return readdirSync(pathOf(full), { encoding: "buffer" }).map((name) => fromBuffer(name));
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
    fd = openSync2(pathOf(path), constants2.O_RDONLY | constants2.O_NONBLOCK | constants2.O_NOCTTY);
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
      const r = readSync2(fd, buf, n, st.size - n, null);
      if (r === 0)
        break;
      n += r;
    }
    return { buf: fromBuffer(buf.subarray(0, n)), state: "ok" };
  } catch {
    return { buf: null, state: "unreadable" };
  } finally {
    closeSync2(fd);
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
var SLICE = "app-loadguard.slice";
var SHOWN = 3;
var MAX_DEPTH = 64;
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
    if (cgroup === null || cgroup.length === 0 || !cstr(cgroup).includes("/" + SLICE + "/"))
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
    for (let depth = 0;depth < MAX_DEPTH; depth++) {
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
function envInt(name, def, lo, hi) {
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
  return envInt(l.env, def, l.lo, l.hi);
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

// ts/lock.ts
import { spawnSync } from "child_process";

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

// ts/watcher.ts
var TICK_S = 2;
var RUNS = 16;
var MAX_DEPTH2 = 64;
var LEARNED_LOCK = "learned.lock";
var LEARNED_MAX = 100;
var LEARN_COMMAND_MAX = 4096;
var INT_MAX3 = 2147483647;
var LONG_MAX = (1n << 63n) - 1n;
var LONG_MIN = -(1n << 63n);
var ULL_MAX = (1n << 64n) - 1n;
function strtol(s, i) {
  let p = i;
  while (isSpace(s[p]))
    p++;
  let neg = false;
  if (s[p] === "+" || s[p] === "-")
    neg = s[p++] === "-";
  const q = p;
  while (isDigit(s[p]))
    p++;
  if (p === q)
    return { v: 0n, end: i };
  let v = BigInt(s.slice(q, p));
  if (neg)
    v = -v;
  return { v: v > LONG_MAX ? LONG_MAX : v < LONG_MIN ? LONG_MIN : v, end: p };
}

class Scan {
  s;
  p = 0;
  constructor(s) {
    this.s = s;
  }
  ws() {
    while (isSpace(this.s[this.p]))
      this.p++;
  }
  char() {
    if (this.p >= this.s.length)
      return false;
    this.p++;
    return true;
  }
  word() {
    this.ws();
    const q = this.p;
    while (this.p < this.s.length && !isSpace(this.s[this.p]))
      this.p++;
    return this.p > q;
  }
  digits() {
    this.ws();
    let p = this.p, neg = false;
    if (this.s[p] === "+" || this.s[p] === "-")
      neg = this.s[p++] === "-";
    const q = p;
    while (isDigit(this.s[p]))
      p++;
    if (p === q)
      return null;
    this.p = p;
    return { neg, v: BigInt(this.s.slice(q, p)) };
  }
  int() {
    const d = this.digits();
    if (d === null)
      return null;
    let v = d.neg ? -d.v : d.v;
    v = v > LONG_MAX ? LONG_MAX : v < LONG_MIN ? LONG_MIN : v;
    return Number(BigInt.asIntN(32, v));
  }
  ull() {
    const d = this.digits();
    if (d === null)
      return null;
    if (d.v > ULL_MAX)
      return ULL_MAX;
    return d.neg ? u64(-d.v) : d.v;
  }
}
function readStat(root, pid) {
  const raw = slurp(root, "/proc/" + pid + "/stat", 1024);
  if (raw === null || raw.length === 0)
    return null;
  const buf = cstr(raw);
  const open = buf.indexOf("("), close = buf.lastIndexOf(")");
  if (open < 0 || close < 0)
    return null;
  const comm = fit(close - open - 1 >= 0 ? buf.slice(open + 1, close) : buf.slice(open + 1), 64);
  const sc = new Scan(buf.slice(close + 1));
  sc.ws();
  if (!sc.char())
    return null;
  const ppid = sc.int();
  if (ppid === null)
    return null;
  for (let i = 0;i < 17; i++)
    if (!sc.word())
      return null;
  const start = sc.ull();
  return start === null ? null : { comm, ppid, start };
}
function readRss(w, pid) {
  const raw = slurp(w.root, "/proc/" + pid + "/statm", 256);
  if (raw === null || raw.length === 0)
    return null;
  const sc = new Scan(cstr(raw));
  if (!sc.word())
    return null;
  const pages = sc.ull();
  return pages === null ? null : u64(pages * w.page);
}
function pageSize() {
  try {
    const auxv = readFileSync("/proc/self/auxv");
    for (let i = 0;i + 16 <= auxv.length; i += 16) {
      const type = auxv.readBigUInt64LE(i);
      if (type === 0n)
        break;
      if (type === 6n)
        return auxv.readBigUInt64LE(i + 8);
    }
  } catch {}
  return 4096n;
}
function harnessOf(root, pid, comm) {
  let name = comm;
  if (name !== "claude" && name !== "codex") {
    const raw = slurp(root, "/proc/" + pid + "/cmdline", 4096);
    if (raw === null || raw.length === 0)
      return 0 /* ANY */;
    name = base(cstr(raw));
  }
  return name === "claude" ? 1 /* CLAUDE */ : name === "codex" ? 2 /* CODEX */ : 0 /* ANY */;
}
function scopeOf(root, pid) {
  const raw = slurp(root, "/proc/" + pid + "/cgroup", 4096);
  if (raw === null || raw.length === 0)
    return null;
  const buf = cstr(raw);
  let p = 0;
  while (!buf.startsWith("0::", p)) {
    const nl = buf.indexOf(`
`, p);
    if (nl < 0)
      return null;
    p = nl + 1;
  }
  const nl = buf.indexOf(`
`, p);
  const line = nl < 0 ? buf.slice(p) : buf.slice(p, nl);
  const slash = line.lastIndexOf("/");
  if (slash < 0)
    return null;
  const name = line.slice(slash + 1);
  if (!name.startsWith("loadguard-") || name.length <= 16 || !name.endsWith(".scope"))
    return null;
  const procs = "/sys/fs/cgroup" + line.slice(3) + "/cgroup.procs";
  return procs.length < PATH_MAX && name.length < 256 ? { procs, name } : null;
}
function makeDirs(file) {
  if (file.length >= PATH_MAX)
    return false;
  const s = file.lastIndexOf("/");
  if (s <= 0)
    return false;
  const dir = file.slice(0, s);
  for (let i = 1;i < dir.length; i++) {
    if (dir[i] !== "/")
      continue;
    try {
      mkdirSync(pathOf(dir.slice(0, i)), { mode: 448 });
    } catch {}
  }
  try {
    mkdirSync(pathOf(dir), { mode: 448 });
    return true;
  } catch (e) {
    return e.code === "EEXIST";
  }
}
function setItem(o, key, item) {
  if (o.t !== "obj")
    return;
  const at = o.items.findIndex(([k]) => k === key);
  if (at >= 0)
    o.items[at][1] = item;
  else
    o.items.push([key, item]);
}
function lastSeen(o) {
  return str(get(o, "last_seen")) ?? "";
}
function writeAll(fd, data) {
  for (let off = 0;off < data.length; )
    off += writeSync(fd, data, off, data.length - off);
}
function writeLessons(path, all) {
  const tmp = path + "." + process.pid + ".tmp";
  let fd;
  try {
    fd = openSync3(pathOf(tmp), constants3.O_WRONLY | constants3.O_CREAT | constants3.O_TRUNC, 384);
  } catch {
    return;
  }
  let ok = true;
  try {
    writeAll(fd, toBuffer(all.map((o) => print(o) + `
`).join("")));
    fsyncSync(fd);
  } catch {
    ok = false;
  }
  try {
    closeSync3(fd);
  } catch {
    ok = false;
  }
  try {
    if (!ok)
      throw new Error("write");
    renameSync(pathOf(tmp), pathOf(path));
  } catch {
    try {
      unlinkSync(pathOf(tmp));
    } catch {}
    return;
  }
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    try {
      const dfd = openSync3(pathOf(path.slice(0, slash)), constants3.O_RDONLY | constants3.O_DIRECTORY);
      try {
        fsyncSync(dfd);
      } finally {
        closeSync3(dfd);
      }
    } catch {}
  }
}
function stamp(now) {
  return new Date(now * 1000).toISOString().slice(0, 19) + "Z";
}
function learnedUpdate(r, now) {
  const path = stateFile(LEARNED_FILE), lockPath = stateFile(LEARNED_LOCK);
  if (path === null || lockPath === null || !makeDirs(lockPath))
    return;
  let lock;
  try {
    lock = openSync3(pathOf(lockPath), constants3.O_RDWR | constants3.O_CREAT, 384);
  } catch {
    return;
  }
  try {
    if (!lockFile(lock, false))
      return;
    const { buf } = readRegular(path, LEARNED_BYTES);
    const all = buf === null ? [] : lessonObjects(buf);
    const when = stamp(now), command = r.command;
    let hit = all.find((o) => str(get(o, "command")) === command);
    if (hit === undefined) {
      hit = jobj([["command", jstr(command)]]);
      all.push(hit);
    }
    const peak = get(hit, "peak_rss"), mine = Number(r.peak);
    setItem(hit, "peak_rss", jnum(peak !== null && peak.t === "num" && peak.v > mine ? peak.v : mine));
    setItem(hit, "cwd", jstr(r.cwd));
    if (get(hit, "first_seen") === null)
      setItem(hit, "first_seen", jstr(when));
    setItem(hit, "last_seen", jstr(when));
    while (all.length > LEARNED_MAX) {
      let oldest = 0;
      for (let i = 1;i < all.length; i++)
        if (lastSeen(all[i]) < lastSeen(all[oldest]))
          oldest = i;
      all.splice(oldest, 1);
    }
    writeLessons(path, all);
  } finally {
    closeSync3(lock);
  }
}
function logRun(w, event, r, why) {
  if (w.log === null)
    return;
  const o = [
    ["tick", jnum(w.pass)],
    ["event", jstr(event)],
    ["pid", jnum(r.pid)],
    ["peak", jnum(Number(r.peak))]
  ];
  if (r.command !== null)
    o.push(["command", jstr(r.command)]);
  if (why !== null)
    o.push(["why", jstr(why)]);
  w.log.push(print(jobj(o)) + `
`);
}
function record(w, r, now, event) {
  learnedUpdate(r, now);
  r.written = r.peak;
  logRun(w, event, r, null);
}
function runCommand(w, pid) {
  const size = 1 << 18;
  const buf = slurp(w.root, "/proc/" + pid + "/cmdline", size);
  if (buf === null || buf.length === 0 || buf.length >= size - 1)
    return { cmd: null, why: "cmdline" };
  const cmd = shellCommand(splitArgv(buf, MAX_WORDS), w.harness);
  if (cmd === null)
    return { cmd: null, why: "form" };
  if (cmd.length === 0 || cmd.length > LEARN_COMMAND_MAX || !validUtf8(cmd))
    return { cmd: null, why: "text" };
  if (heavyCommand(cmd) !== null)
    return { cmd: null, why: "fixed" };
  return { cmd, why: "" };
}
function startRun(w, sh, now) {
  if (w.runs.length === RUNS) {
    logRun(w, "skip", { pid: sh.pid, peak: sh.sum, command: null }, "full");
    return;
  }
  const r = { pid: sh.pid, learning: false, start: sh.start, peak: sh.sum, written: 0n, command: null, cwd: "" };
  w.runs.push(r);
  const { cmd, why } = runCommand(w, sh.pid);
  if (cmd === null) {
    logRun(w, "skip", r, why);
    return;
  }
  r.command = cmd;
  const path = fit(w.root + "/proc/" + sh.pid + "/cwd", 64);
  try {
    r.cwd = fromBuffer(readlinkSync2(pathOf(path), { encoding: "buffer" })).slice(0, PATH_MAX - 1);
  } catch {
    r.cwd = "";
  }
  r.cwd = sanitize(cstr(r.cwd));
  r.learning = true;
  record(w, r, now, "learn");
}
function endRun(w, i, now) {
  const r = w.runs[i];
  if (r.learning)
    record(w, r, now, "end");
  w.runs[i] = w.runs[w.runs.length - 1];
  w.runs.pop();
}
function findW(ps, pid) {
  let l = 0, u = ps.length;
  while (l < u) {
    const idx = l + u >> 1, other = ps[idx].pid;
    if (pid < other)
      u = idx;
    else if (pid > other)
      l = idx + 1;
    else
      return idx;
  }
  return -1;
}
function topShell(ps, i, session) {
  let top = -1, p = i;
  for (let depth = 0;depth < MAX_DEPTH2 && ps[p].pid !== session; depth++) {
    const proc = ps[p];
    if (proc.shell)
      top = p;
    if (proc.ppid === session)
      return top;
    if ((p = findW(ps, proc.ppid)) < 0)
      return -1;
  }
  return -1;
}
function watchTick(w, now) {
  const st = readStat(w.root, w.session);
  const buf = st === null || st.start !== w.since ? null : slurp(w.root, w.procs, 1 << 16);
  if (buf === null) {
    while (w.runs.length > 0)
      endRun(w, w.runs.length - 1, now);
    return false;
  }
  const text = cstr(buf), ps = [];
  for (let p = 0;; ) {
    const { v, end } = strtol(text, p);
    if (end === p)
      break;
    p = end;
    if (v <= 0n || v > BigInt(INT_MAX3) || v === BigInt(w.self))
      continue;
    const pid = Number(v), s = readStat(w.root, pid);
    const rss = s === null ? null : readRss(w, pid);
    if (s === null || rss === null)
      continue;
    ps.push({ pid, ppid: s.ppid, shell: SHELLS.includes(s.comm), start: s.start, rss, sum: 0n });
  }
  ps.sort((a, b) => a.pid - b.pid);
  for (let i = 0;i < ps.length; i++) {
    const top = topShell(ps, i, w.session);
    if (top >= 0)
      ps[top].sum = u64(ps[top].sum + ps[i].rss);
  }
  for (let j = w.runs.length - 1;j >= 0; j--) {
    const r = w.runs[j], at = findW(ps, r.pid);
    if (at < 0 || ps[at].start !== r.start) {
      endRun(w, j, now);
      continue;
    }
    const sh = ps[at];
    if (sh.sum > r.peak)
      r.peak = sh.sum;
    if (r.learning && r.peak >= r.written + r.written / 10n)
      record(w, r, now, "grow");
  }
  for (const sh of ps) {
    if (!sh.shell || sh.sum < w.limit)
      continue;
    if (!w.runs.some((r) => r.pid === sh.pid && r.start === sh.start))
      startRun(w, sh, now);
  }
  return true;
}
function watchSetup(root, pid, log) {
  const st = readStat(root, pid);
  if (st === null)
    return null;
  const harness = harnessOf(root, pid, st.comm);
  if (harness === 0 /* ANY */)
    return null;
  const sc = scopeOf(root, pid);
  if (sc === null)
    return null;
  const buf = slurp(root, "/proc/meminfo", 8192);
  const total = buf === null || buf.length === 0 ? null : meminfo(cstr(buf), "MemTotal:");
  if (total === null || total === 0n)
    return null;
  const w = {
    root,
    session: pid,
    self: process.pid,
    since: st.start,
    harness,
    procs: sc.procs,
    limit: u64(u64(u64(total * 1024n) / 100n) * BigInt(limit("learnRss", LEARN_RSS_DEFAULT))),
    page: pageSize(),
    runs: [],
    log,
    pass: 0
  };
  return { w, scope: sc.name };
}
function watchLock(scope) {
  const run = getenv("XDG_RUNTIME_DIR");
  if (run === null || run[0] !== "/")
    return null;
  const path = run + "/loadguard/" + scope + ".watch";
  if (path.length >= PATH_MAX || !makeDirs(path))
    return null;
  let fd;
  try {
    fd = openSync3(pathOf(path), constants3.O_RDWR | constants3.O_CREAT, 384);
  } catch {
    return null;
  }
  if (!lockFile(fd, true)) {
    closeSync3(fd);
    return null;
  }
  try {
    ftruncateSync(fd, 0);
    writeAll(fd, toBuffer(process.pid + `
`));
  } catch {}
  return { fd, path };
}
function watchUnlock(lock) {
  try {
    unlinkSync(pathOf(lock.path));
  } catch {}
  closeSync3(lock.fd);
}
function watch(arg) {
  const { v, end } = strtol(arg, 0);
  if (arg === "" || end !== arg.length || v <= 1n || v > BigInt(INT_MAX3) || learnOff())
    return;
  try {
    process.chdir("/");
  } catch {
    return;
  }
  try {
    setPriority(10);
  } catch {}
  const setup = watchSetup("", Number(v), null);
  if (setup === null)
    return;
  const lock = watchLock(setup.scope);
  if (lock === null)
    return;
  while (watchTick(setup.w, Math.floor(Date.now() / 1000)))
    Bun.sleepSync(TICK_S * 1000);
  watchUnlock(lock);
}

// ts/watch.ts
var args = process.argv.slice(2);
try {
  if (args.length === 1)
    watch(args[0]);
} catch {}
process.exit(0);
