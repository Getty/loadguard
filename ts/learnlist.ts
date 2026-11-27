// The learned list (k15) for `loadguard learned` / `forget` and doctor's
// watcher check, ported from lib/loadguard/learn.py (state_dir, list_path,
// parse, read, rewrite, forget, watch_file, watcher). The hook's own reading
// is ts/learned.ts; this is the CLI's, with Python's text rules: the file
// decoded as UTF-8 with replacement, one JSON document per "\n" line, and
// what is kept written back as json.dumps(ensure_ascii=False, separators=
// (",", ":")) writes it. Writes take the flock on learned.lock that the
// watchers (C and TS) take, and replace the file by a rename.
//
// Not mirrored (noted on k22): Python's json reads NaN/Infinity and keeps
// integers beyond 2^53 and 1.0 apart from 1; JSON.parse does neither.
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { loadLibc } from "./libc.js";
import { lockFile } from "./lock.js";
import { type Environ, pyInt, pySplit } from "./scope.js";

export const FILE = "learned.jsonl";
const LOCK = "learned.lock";
export const MAX_BYTES = 1 << 20; // the hook ignores a larger list
const MAX_LINES = 256;            // and reads no more lines than this

export type Entry = Record<string, unknown>;

/** A value forget() turns into "forget: <text>; nothing changed". */
export class ForgetError extends Error {}

/** OSError.strerror of a runtime error, or its text. */
export function strerror(e: unknown): string {
  const errno = (e as { errno?: unknown }).errno;
  const libc = typeof errno === "number" ? loadLibc() : null;
  if (libc !== null) return libc.strerror(Math.abs(errno as number));
  return e instanceof Error ? e.message : String(e);
}

export function disabled(environ: Environ): boolean {
  return environ["LOADGUARD_LEARN"] === "0";
}

/** os.path.join */
function join(a: string, ...parts: string[]): string {
  let out = a;
  for (const p of parts) out = p.startsWith("/") ? p : out === "" || out.endsWith("/") ? out + p : out + "/" + p;
  return out;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  return head !== "" && head !== "/".repeat(head.length) ? head.replace(/\/+$/, "") : head;
}

/**
 * ${XDG_STATE_HOME:-$HOME/.local/state}/loadguard, as the hook finds it; null
 * if neither is an absolute path.
 */
export function stateDir(environ: Environ): string | null {
  const xdg = environ["XDG_STATE_HOME"] ?? "", home = environ["HOME"] ?? "";
  if (xdg.startsWith("/")) return join(xdg, "loadguard");
  if (home.startsWith("/")) return join(home, ".local", "state", "loadguard");
  return null;
}

export function listPath(environ: Environ): string | null {
  const d = stateDir(environ);
  return d !== null ? join(d, FILE) : null;
}

function isEntry(v: unknown): v is Entry {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as Entry)["command"] === "string";
}

/** The entries of a list text, as the hook reads them. */
export function parse(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n").slice(0, MAX_LINES)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isEntry(entry)) out.push(entry);
  }
  return out;
}

/** [entries, problem]: problem null, "too-large" or the strerror text. */
export function read(path: string): [Entry[], string | null] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [[], null];
    return [[], strerror(e)];
  }
  const buf = Buffer.alloc(MAX_BYTES + 1);
  let n = 0;
  try {
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0 || (n += got) === buf.length) break;
    }
  } catch (e) {
    return [[], strerror(e)];
  } finally {
    closeSync(fd);
  }
  if (n > MAX_BYTES) return [[], "too-large"];
  return [parse(new TextDecoder("utf-8").decode(buf.subarray(0, n))), null];
}

/** os.makedirs(path, mode, exist_ok=True), the original error kept. */
function makedirs(path: string, mode: number): void {
  const head = dirname(path);
  if (head !== "" && !path.endsWith("/") && !existsSync(head)) makedirs(head, 0o777);
  try {
    mkdirSync(path, { mode });
  } catch (e) {
    let dir = false;
    try {
      dir = statSync(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) throw e;
  }
}

/** The list replaced by entries, atomically; none left: no file. */
function rewrite(path: string, entries: Entry[]): void {
  if (entries.length === 0) {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") throw e;
    }
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      const data = Buffer.from(entries.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
      for (let n = 0; n < data.length;) n += writeSync(fd, data, n);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/**
 * Drop entries by number (1-based, as `loadguard learned` counts), or all
 * with numbers null — then the file goes, readable or not. Returns the
 * dropped entries; ForgetError names a number not in the list, and nothing
 * changes then. Runtime errors (OSError in Python) are thrown as they are.
 */
export function forget(path: string, numbers: number[] | null): Entry[] {
  makedirs(dirname(path), 0o700);
  const lock = openSync(join(dirname(path), LOCK), "a");
  try {
    lockFile(lock, false);
    const [entries, problem] = read(path);
    let dropped: Entry[], kept: Entry[];
    if (numbers === null) {
      [dropped, kept] = [entries, []];
    } else if (problem !== null) {
      throw new ForgetError(`the list cannot be read (${problem})`);
    } else {
      const bad = numbers.filter((n) => !(1 <= n && n <= entries.length));
      if (bad.length > 0) throw new ForgetError(`no entry ${bad[0]}: the list has ${entries.length}`);
      dropped = entries.filter((_e, i) => numbers.includes(i + 1));
      kept = entries.filter((_e, i) => !numbers.includes(i + 1));
    }
    rewrite(path, kept);
    return dropped;
  } finally {
    closeSync(lock);
  }
}

// --- the watcher -------------------------------------------------------------

function watchFile(runtimeDir: string, scope: string): string {
  return join(runtimeDir, "loadguard", scope + ".watch");
}

/**
 * Is this argv a watcher? The C binary's `loadguard-hook --watch PID`, or
 * dist/watch.js as ts/scope.ts starts it: `bun <flags> .../watch.js PID`.
 */
function isWatcher(argv: string[]): boolean {
  if (argv.length > 2 && argv[1] === "--watch") return true;
  const i = argv.findIndex((a, n) => n > 0 && (a === "watch.js" || a.endsWith("/watch.js")));
  return i > 0 && /^[0-9]+$/.test(argv[i + 1] ?? "");
}

/** The pid of the watcher holding scope's lock, or null. */
export function watcher(environ: Environ, scope: string, procRoot = ""): number | null {
  const runtime = environ["XDG_RUNTIME_DIR"] ?? "";
  if (!runtime.startsWith("/") || scope === "") return null;
  let pid: number, argv: string[];
  try {
    const raw = readFileSyncOrNull(watchFile(runtime, scope));
    if (raw === null || /[^\x00-\x7f]/.test(raw.toString("latin1"))) return null;
    const first = pySplit(raw.toString("latin1").replace(/\r\n?/g, "\n"))[0];
    if (first === undefined) return null;
    pid = pyInt(first);
    const cmdline = readFileSyncOrNull(`${procRoot}/proc/${pid}/cmdline`);
    if (cmdline === null) return null;
    argv = cmdline.toString("latin1").split("\0");
  } catch {
    return null;
  }
  return isWatcher(argv) ? pid : null;
}

function readFileSyncOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
