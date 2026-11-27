// Heavy commands — one classifier for the words of an incoming command and
// for the argv of a running process — the lexer that finds the simple
// commands of a Bash string, and the Bash call behind a running shell.
// Ported from src/loadguard-hook.c (classify, heavy_command, claude_eval,
// shell_command, split_argv); every string is a byte string (bytes.ts).
import { type Bytes, fit, isAlpha, isDigit } from "./bytes.js";

export enum Kind {
  NONE,
  PROVE,    // prove
  SUITE,    // a whole test suite: make test, dzil test|release, …
  BUILD,    // builds, installs, containers, perlbench
  AGENT,    // claude -p|--print|--bg, codex exec|e|review: heavy to start, holds no slot
  LEARNED,  // the exact text of a command in the learned list (k15)
}

export interface Match {
  kind: Kind;
  /** Index of the command word in the argv judged. */
  at: number;
  /** "prove", "make test", "podman run", "learned: …" (< 64 bytes). */
  label: Bytes;
}

const LABEL_SIZE = 64;

const INTERPRETERS = ["perl", "python", "python3", "node", "sh", "bash", "dash"];
const CLAUDE_HEADLESS = ["-p", "--print", "--bg"];
const CODEX_HEADLESS = ["exec", "e", "review"];

export function base(s: Bytes): Bytes {
  const slash = s.lastIndexOf("/");
  return slash < 0 ? s : s.slice(slash + 1);
}

/** The first argument that is no option (-x, --x, cargo's +toolchain). */
function subcommand(av: Bytes[]): Bytes {
  for (let i = 1; i < av.length; i++) {
    const a = av[i] as Bytes;
    if (a[0] !== "-" && a[0] !== "+") return a;
  }
  return "";
}

/**
 * What argv runs, judged by its words: the basename of argv[0] and, for
 * tools with subcommands, the first argument that is no option. An
 * interpreter is looked through to its script, but inline code (-c, -e, -E)
 * is no script.
 */
export function classify(argv: Bytes[]): Match | null {
  let at = 0;
  if (argv.length < 1) return null;
  if (INTERPRETERS.includes(base(argv[0] as Bytes))) {
    for (at = 1; at < argv.length && (argv[at] as Bytes)[0] === "-"; at++) {
      const a = argv[at];
      if (a === "-c" || a === "-e" || a === "-E") return null;
    }
    if (at === argv.length) return null;
  }
  const av = argv.slice(at);
  const name = base(av[0] as Bytes);
  let sub = subcommand(av);
  let kind = Kind.NONE;

  if (name === "prove") {
    kind = Kind.PROVE;
    sub = "";
  } else if (name === "cpanm" || name === "perlbench") {
    kind = Kind.BUILD;
    sub = "";
  } else if (name === "dzil") {
    if (sub === "build") kind = Kind.BUILD;
    else if (sub === "test" || sub === "release") kind = Kind.SUITE;
  } else if (name === "make") {
    if (av.slice(1).includes("test")) {
      kind = Kind.SUITE;
      sub = "test";
    }
  } else if (name === "docker" || name === "podman") {
    if (sub === "build" || sub === "run") kind = Kind.BUILD;
  } else if (name === "cargo") {
    if (sub === "build") kind = Kind.BUILD;
    else if (sub === "test") kind = Kind.SUITE;
  } else if (name === "npm") {
    if (sub === "test") kind = Kind.SUITE;
  } else if (name === "claude" || name === "codex") {
    const headless = name === "claude" ? CLAUDE_HEADLESS : CODEX_HEADLESS;
    const word = av.slice(1).find((a) => headless.includes(a));
    if (word !== undefined) {
      kind = Kind.AGENT;
      sub = word;
    }
  }
  if (kind === Kind.NONE) return null;
  return { kind, at, label: fit(name + (sub !== "" ? " " + sub : ""), LABEL_SIZE) };
}

// --- the lexer ---------------------------------------------------------------

const MAX_WORDS = 32;
const WORD_MAX = 256;
const MAX_HEREDOCS = 8;
const DELIM_MAX = 64;

/** Words in front of the command word that keep it in command position. */
const PREFIXES = [
  "!", "{", "}", "if", "then", "else", "elif", "while", "until", "do",
  "time", "exec", "nice", "ionice", "nohup", "timeout", "env", "stdbuf",
  "setsid", "xargs",
];

function assignment(w: Bytes): boolean {
  let i = 0;
  if (!isAlpha(w[0]) && w[0] !== "_") return false;
  while (isAlpha(w[i]) || isDigit(w[i]) || w[i] === "_") i++;
  return w[i] === "=" || (w[i] === "+" && w[i + 1] === "=");
}

class Words {
  w: Bytes[] = [];     // words complete
  cur = "";            // the open word
  open = false;        // a word is open ('' opens an empty one)
  skip = false;        // the next word is a redirection target

  begin(): void {
    if (!this.open) {
      this.open = true;
      this.cur = "";
    }
  }

  put(c: string): void {
    this.begin();
    if (this.w.length < MAX_WORDS && this.cur.length < WORD_MAX - 1) this.cur += c;
  }

  endWord(): void {
    if (!this.open) return;
    this.open = false;
    if (this.skip) this.skip = false;
    else if (this.w.length < MAX_WORDS) this.w.push(this.cur);
  }

  /** Judge the collected simple command, then start the next one. */
  endCommand(): Match | null {
    this.endWord();
    this.skip = false;
    let i = 0, prefixed = false;
    for (; i < this.w.length; i++) {
      const w = this.w[i] as Bytes;
      if (assignment(w)) continue;
      if (prefixed && (w[0] === "-" || isDigit(w[0]))) continue; // nice -n 10, timeout 5m, xargs -P4
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

/** s[i], or NUL past the end: the C string's terminator. */
function at(s: Bytes, i: number): string {
  return i < s.length ? (s[i] as string) : "\0";
}

/**
 * p is at the first '<' of "<<" or "<<-". The delimiter word (quotes
 * removed, < 64 bytes), whether tabs are stripped, and the index of the last
 * character consumed.
 */
function heredocStart(s: Bytes, p: number): { delim: Bytes; strip: boolean; last: number } {
  let delim = "", quote = "", strip = false;
  p += 2;
  if (at(s, p) === "-") {
    strip = true;
    p++;
  }
  while (at(s, p) === " " || at(s, p) === "\t") p++;
  for (; at(s, p) !== "\0"; p++) {
    const c = at(s, p);
    if (quote !== "") {
      if (c === quote) quote = "";
      else if (delim.length < DELIM_MAX - 1) delim += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\" && at(s, p + 1) !== "\0") p++;
    else if (" \t\n;&|()<>`".includes(c)) break;
    if (delim.length < DELIM_MAX - 1) delim += at(s, p);
  }
  return { delim, strip, last: p - 1 };
}

/**
 * p is at the newline that ends the line with the heredoc operators. Skips
 * their bodies; the index of the newline or the end after the last
 * delimiter line, -1 if the text ends inside a body.
 */
function skipHeredocs(s: Bytes, p: number, docs: { delim: Bytes; strip: boolean }[]): number {
  for (const doc of docs) {
    for (;;) {
      if (at(s, p) !== "\n") return -1;
      let line = p + 1;
      let end = s.indexOf("\n", line);
      if (end < 0) end = s.length;
      p = end;
      if (doc.strip) while (at(s, line) === "\t") line++;
      if (end - line === doc.delim.length && s.startsWith(doc.delim, line)) break;
    }
  }
  return p;
}

/** The first heavy simple command in a Bash command string, else null. */
export function heavyCommand(cmd: Bytes): Match | null {
  const s = new Words();
  const docs: { delim: Bytes; strip: boolean }[] = [];
  let q: "plain" | "single" | "double" = "plain";

  for (let p = 0; p < cmd.length; p++) {
    const c = cmd[p] as string;
    if (q === "single") {
      if (c === "'") q = "plain";
      else s.put(c);
      continue;
    }
    if (q === "double") {
      if (c === '"') {
        q = "plain";
      } else if (c === "\\" && at(cmd, p + 1) !== "\0" && "\"\\$`\n".includes(at(cmd, p + 1))) {
        if (at(cmd, p + 1) !== "\n") s.put(at(cmd, p + 1));
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
        if (at(cmd, p + 1) === "\n") p++; // line continuation
        else if (at(cmd, p + 1) !== "\0") s.put(at(cmd, ++p));
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
        while (at(cmd, p + 1) !== "\0" && at(cmd, p + 1) !== "\n") p++; // comment
        break;
      case "<":
      case ">":
        if (c === "<" && at(cmd, p + 1) === "<" && at(cmd, p + 2) !== "<") {
          s.endWord();
          const doc = heredocStart(cmd, p);
          if (docs.length < MAX_HEREDOCS && doc.delim !== "") docs.push(doc);
          p = doc.last;
          break;
        }
        s.endWord(); // <, >, >>, >|, >&, <&, <<<, <>
        while ("<>&|".includes(at(cmd, p + 1)) && at(cmd, p + 1) !== "\0") p++;
        s.skip = true;
        break;
      case "&":
        if (at(cmd, p + 1) === ">") { // &>, &>>
          s.endWord();
          while (at(cmd, p + 1) === ">") p++;
          s.skip = true;
          break;
        }
        separator = true;
        break;
      case "\n":
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
      if (m !== null) return m;
      if (c === "\n" && docs.length > 0) {
        p = skipHeredocs(cmd, p, docs);
        docs.length = 0;
        if (p < 0 || p >= cmd.length) return null;
      }
    }
  }
  return s.endCommand();
}

// --- the Bash call behind a running shell (k15) ------------------------------

export const SHELLS = ["bash", "sh", "dash", "zsh"];

export enum Harness {
  ANY,     // the slot scan: Claude Code's wrapper, else Codex's
  CLAUDE,  // only Claude Code's wrapper
  CODEX,   // only Codex's plain string
}

/**
 * The eval text of Claude Code's wrapper around a Bash call, null if s is
 * not that wrapper (recorded with 2.1.283, t/fixtures/shells/claude-code.json):
 *   source <snapshot> … || true && eval '<command>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd
 */
export function claudeEval(s: Bytes): Bytes | null {
  let p = s.indexOf("eval ");
  while (p > 0 && s[p - 1] !== " ") p = s.indexOf("eval ", p + 1);
  if (p < 0) return null;
  let out = "";
  for (p += 5; at(s, p) !== "\0" && at(s, p) !== " ";) {
    const c = at(s, p);
    if (c === "'") {
      const q = s.indexOf("'", p + 1);
      if (q < 0) return null;
      out += s.slice(p + 1, q);
      p = q + 1;
    } else if (c === '"') {
      for (p++; at(s, p) !== '"'; p++) {
        const d = at(s, p);
        if (d === "\0" || d === "$" || d === "`") return null;
        if (d === "\\" && at(s, p + 1) !== "\0" && "\"\\$`\n".includes(at(s, p + 1))) {
          p++;
          if (at(s, p) === "\n") continue; // line continuation
        }
        out += at(s, p);
      }
      p++;
    } else if (c === "\\" && at(s, p + 1) !== "\0") {
      if (at(s, p + 1) !== "\n") out += at(s, p + 1);
      p += 2;
    } else {
      return null;
    }
  }
  if (s.startsWith(" < /dev/null", p)) p += 12;
  if (!s.startsWith(" && pwd -P >| ", p)) return null;
  p += 14;
  let q = p;
  while (q < s.length && !" \t\n'\"\\$`;&|<>()".includes(s[q] as string)) q++;
  return q === s.length && q - p > 4 && s.endsWith("-cwd") ? out : null;
}

/**
 * The command a running `<shell> -c|-lc <string>` executes; null if argv is
 * no such shell or the string is not of the harness's form. Claude Code: the
 * eval text of its wrapper. Codex: the string itself.
 */
export function shellCommand(av: Bytes[], h: Harness): Bytes | null {
  if (av.length < 3 || !SHELLS.includes(base(av[0] as Bytes)) || (av[1] !== "-c" && av[1] !== "-lc"))
    return null;
  let cmd: Bytes | null = null;
  if (h !== Harness.CODEX) cmd = claudeEval(av[2] as Bytes);
  if (cmd === null && h !== Harness.CLAUDE) cmd = av[2] as Bytes;
  return cmd;
}

/** The NUL-separated args of a cmdline (len bytes); trailing empty ones dropped. */
export function splitArgv(buf: Bytes, max: number): Bytes[] {
  const av: Bytes[] = [];
  for (let p = 0; p < buf.length && av.length < max;) {
    let end = buf.indexOf("\0", p);
    if (end < 0) end = buf.length;
    av.push(buf.slice(p, end));
    p = end + 1;
  }
  while (av.length > 1 && av[av.length - 1] === "") av.pop();
  return av;
}

export { MAX_WORDS };
