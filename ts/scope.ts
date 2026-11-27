// Stage 1, the session scope (k3), ported from lib/loadguard/confine.py, and
// the start of the scope's watcher, ported from start_watcher in
// lib/loadguard/learn.py. The rules and their reasons are documented there;
// this is the same logic, call for call:
//
// - the session process: the nearest ancestor whose comm or argv[0] is
//   claude or codex; already in a loadguard-*.scope: nothing happens;
// - no linger, no user bus, no busctl, no memory delegation (cached per
//   boot in $XDG_RUNTIME_DIR/loadguard/delegation), no MemTotal: nothing;
// - StartTransientUnit with PIDs= holding the session process alone, the
//   move confirmed in /proc, then the older descendants with
//   AttachProcessesToUnit (one batch, else one PID at a time);
// - the busctl argv byte for byte as confine.py builds it.
//
// Python's text handling is kept where a decision hangs on it: files are read
// as UTF-8 with replacement and universal newlines, str.strip/split/
// splitlines and int() keep Python's whitespace and digit rules, and an error
// Python does not catch is not caught here either (the entry turns it into
// exit 0, as hooks/loadguard-confine does).
//
// `root` prefixes /proc, /sys and /var so tests point the code at a fixture
// tree; it is "" in production.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import { loadLibc } from "./libc.js";

export const SLICE = "app-loadguard.slice";
export const PREFIX = "loadguard-";

/** Percent of MemTotal, CPU weight 1..10000 (systemd default 100). */
export const DEFAULTS: readonly (readonly [string, string, number, number, number])[] = [
  ["MemoryHigh", "LOADGUARD_MEMORY_HIGH", 30, 1, 100],
  ["MemoryMax", "LOADGUARD_MEMORY_MAX", 40, 1, 100],
  ["MemorySwapMax", "LOADGUARD_MEMORY_SWAP_MAX", 10, 0, 100],
  ["CPUWeight", "LOADGUARD_CPU_WEIGHT", 50, 1, 10000],
];

const SESSION_NAMES = ["claude", "codex"];
export const MAX_DEPTH = 8;        // ancestors searched for the session process
export const BUSCTL_TIMEOUT_S = 2;
export const CONFIRM_S = 1.0;      // wait this long for the asynchronous move

/** What the starters remove from Bun's environment (getty-bun contract). */
export const BUN_ENV_REMOVED = [
  "BUN_OPTIONS", "BUN_INSPECT_PRELOAD", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO",
  "NODE_PATH", "NODE_COMPILE_CACHE", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "BUN_INTERNAL_WEBVIEW_HOST",
];

export type Environ = Record<string, string | undefined>;

/** A Python exception class where the Python code catches by class. */
export class PyError extends Error {
  constructor(readonly kind: "OSError" | "ValueError" | "IndexError", message: string) {
    super(kind + ": " + message);
  }
}

// --- Python's str semantics ----------------------------------------------------

const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const SPLIT = new RegExp(`[${PY_WS}]+`);
const LINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const MEMTOTAL = new RegExp(`(?:^|(?<=\\n))MemTotal:[${PY_WS}]+([0-9]+) kB(?=\\n|$)`);

/** str.strip() */
export function pyStrip(s: string): string {
  return s.replace(STRIP, "");
}

/** str.split() */
export function pySplit(s: string): string[] {
  return s.split(SPLIT).filter((w) => w !== "");
}

/** str.splitlines() */
function pySplitlines(s: string): string[] {
  const lines = s.split(LINES);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** int() of a token (ASCII digits, one "_" between digits allowed). */
function pyInt(s: string): number {
  const t = pyStrip(s);
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(t)) throw new PyError("ValueError", "invalid literal for int(): " + s);
  return Number(BigInt(t.replace(/_/g, "")));
}

/** os.path.join */
function pyJoin(a: string, ...parts: string[]): string {
  let out = a;
  for (const p of parts) out = p.startsWith("/") ? p : out === "" || out.endsWith("/") ? out + p : out + "/" + p;
  return out;
}

/** String.prototype.isWellFormed: no lone surrogate (not in the ES2022 lib). */
function wellFormed(s: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  return head !== "" && head !== "/".repeat(head.length) ? head.replace(/\/+$/, "") : head;
}

/** os.makedirs(path, mode, exist_ok=True) */
function makedirs(path: string, mode: number): void {
  const head = dirname(path);
  if (head !== "" && basename(path) !== "" && !existsSync(head)) makedirs(head, 0o777);
  try {
    mkdirSync(path, { mode });
  } catch (e) {
    let dir = false;
    try {
      dir = statSync(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) throw new PyError("OSError", String(e));
  }
}

const DECODER = new TextDecoder("utf-8");

/** open(root + path, encoding="utf-8", errors="replace").read() */
export function read(root: string, path: string): string {
  let buf: Buffer;
  try {
    buf = readFileSync(root + path);
  } catch (e) {
    throw new PyError("OSError", String(e));
  }
  return DECODER.decode(buf).replace(/\r\n?/g, "\n");
}

// --- the host ------------------------------------------------------------------

/** MemTotal in bytes, or null. */
export function memTotal(root: string): bigint | null {
  const m = MEMTOTAL.exec(read(root, "/proc/meminfo"));
  return m === null ? null : BigInt(m[1] as string) * 1024n;
}

/** An integer from the environment (a trailing % allowed), else def. */
function envInt(environ: Environ, name: string, def: number, lo: number, hi: number): number {
  const m = /^([0-9]+)%?$/.exec(environ[name] ?? "");
  if (m !== null) {
    const n = BigInt(m[1] as string);
    if (BigInt(lo) <= n && n <= BigInt(hi)) return Number(n);
  }
  return def;
}

/** [property, value] for the scope, memory in bytes; null if unknown. */
export function limits(root: string, environ: Environ): [string, bigint][] | null {
  const total = memTotal(root);
  if (!total) return null;
  return DEFAULTS.map(([prop, name, def, lo, hi]) => {
    const n = BigInt(envInt(environ, name, def, lo, hi));
    return [prop, prop === "CPUWeight" ? n : (total * n) / 100n];
  });
}

export function controllersPath(uid: number): string {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
}

/**
 * Is the memory controller delegated to the user manager? Cached per boot in
 * <runtimeDir>/loadguard/delegation as "<boot_id> yes|no"; an unreadable
 * controllers file is "no", not cached.
 */
export function delegated(root: string, runtimeDir: string, uid: number): boolean {
  const boot = pyStrip(read(root, "/proc/sys/kernel/random/boot_id"));
  const cache = pyJoin(runtimeDir, "loadguard", "delegation");
  try {
    const cached = pySplit(read("", cache));
    if (cached.length === 2 && cached[0] === boot && (cached[1] === "yes" || cached[1] === "no"))
      return cached[1] === "yes";
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
  }
  let yes: boolean;
  try {
    yes = pySplit(read(root, controllersPath(uid))).includes("memory");
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    return false;
  }
  try {
    makedirs(dirname(cache), 0o700);
    const tmp = `${cache}.${process.pid}`;
    writeFileSync(tmp, `${boot} ${yes ? "yes" : "no"}\n`);
    renameSync(tmp, cache);
  } catch {
    // an unwritable cache still answers
  }
  return yes;
}

/**
 * The login name of uid as getpwuid() finds it (NSS included); without
 * libc through bun:ffi, the first entry for uid in /etc/passwd. null if
 * there is none.
 */
export function userName(uid: number): string | null {
  const libc = loadLibc();
  if (libc !== null) return libc.userName(uid);
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f.length >= 3 && f[2] === String(uid)) return f[0] as string;
    }
  } catch {
    // no passwd file
  }
  return null;
}

/** Has logind a linger file for the user? */
export function lingering(root: string, user: string | null): boolean {
  return user !== null && existsSync(root + "/var/lib/systemd/linger/" + user);
}

export function ppid(root: string, pid: number): number {
  const stat = read(root, `/proc/${pid}/stat`);
  // comm may hold spaces and parens: the fields follow the last ')'.
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new PyError("ValueError", "substring not found");
  const fields = pySplit(stat.slice(close + 2));
  if (fields.length < 2) throw new PyError("IndexError", "list index out of range");
  return pyInt(fields[1] as string);
}

/** "claude" or "codex" if pid's comm or argv[0] is one of them, else null. */
export function sessionName(root: string, pid: number): string | null {
  try {
    const comm = pyStrip(read(root, `/proc/${pid}/comm`));
    if (SESSION_NAMES.includes(comm)) return comm;
    const name = basename(read(root, `/proc/${pid}/cmdline`).split("\0")[0] as string);
    return SESSION_NAMES.includes(name) ? name : null;
  } catch (e) {
    if (e instanceof PyError && e.kind === "OSError") return null;
    throw e;
  }
}

/** [session pid, pids between it and start] or [null, []]. */
export function findSession(root: string, start: number): [number | null, number[]] {
  const chain: number[] = [];
  let pid = start;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (pid <= 1) break;
    if (sessionName(root, pid) !== null) return [pid, chain];
    chain.push(pid);
    pid = ppid(root, pid);
  }
  return [null, []];
}

/** The cgroup v2 path of pid, or null (v1 / hybrid only). */
export function cgroup(root: string, pid: number): string | null {
  for (const line of pySplitlines(read(root, `/proc/${pid}/cgroup`)))
    if (line.startsWith("0::")) return line.slice(3);
  return null;
}

export function inLoadguardScope(path: string): boolean {
  return path.split("/").some((p) => p.startsWith(PREFIX) && p.endsWith(".scope"));
}

/** All live descendants of pid, found by one pass over /proc. */
export function descendants(root: string, pid: number): number[] {
  let names: string[];
  try {
    names = readdirSync(root + "/proc");
  } catch (e) {
    throw new PyError("OSError", String(e));
  }
  const children = new Map<number, number[]>();
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const child = pyInt(name), parent = ppid(root, child);
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [child]);
      else list.push(child);
    } catch (e) {
      // gone meanwhile, or a stat we cannot parse
      if (!(e instanceof PyError) || e.kind === "IndexError") throw e;
    }
  }
  const out: number[] = [], todo = [pid];
  while (todo.length > 0) {
    for (const child of children.get(todo.pop() as number) ?? []) {
      out.push(child);
      todo.push(child);
    }
  }
  return out;
}

export function scopeName(sessionId: string | null, pid: number): string {
  const short = (sessionId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `${PREFIX}${short !== "" ? short + "-" : ""}${pid}.scope`;
}

export function busctlArgv(busctl: string, name: string, pids: number[],
                           props: [string, bigint | number][], description: string): string[] {
  const argv = [busctl, "--user", `--timeout=${BUSCTL_TIMEOUT_S}`, "call",
    "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager", "StartTransientUnit",
    "ssa(sv)a(sa(sv))", name, "fail"];
  const sv: [string, string, string[]][] = [
    ["Description", "s", [description]], ["Slice", "s", [SLICE]],
    ["PIDs", "au", [String(pids.length), ...pids.map(String)]],
    ...props.map(([k, v]): [string, string, string[]] => [k, "t", [String(v)]]),
    // A kernel OOM kill of the outlier must not stop the scope, and with it
    // the session: OOMPolicy defaults to stop. Delegate: AttachProcessesToUnit
    // refuses non-delegated units.
    ["OOMPolicy", "s", ["continue"]],
    ["CollectMode", "s", ["inactive-or-failed"]],
    ["Delegate", "b", ["true"]],
  ];
  argv.push(String(sv.length));
  for (const [key, sig, value] of sv) argv.push(key, sig, ...value);
  argv.push("0"); // no auxiliary units
  return argv;
}

/**
 * subprocess.run(argv, stdin=DEVNULL, capture_output=True, timeout=3): the
 * exit code. Throws where Python raises: an argument it cannot pass (NUL, a
 * lone surrogate), a busctl it cannot start, the timeout.
 */
function run(argv: string[]): number | null {
  for (const a of argv)
    if (a.includes("\0") || !wellFormed(a)) throw new PyError("ValueError", "argument not passable");
  const r = Bun.spawnSync({
    cmd: argv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    timeout: (BUSCTL_TIMEOUT_S + 1) * 1000, killSignal: "SIGKILL",
  });
  if (r.exitedDueToTimeout) throw new PyError("OSError", "busctl timed out");
  return r.exitCode;
}

/** True if systemd accepted the job. */
export function startScope(busctl: string, name: string, pids: number[],
                           props: [string, bigint | number][], description: string): boolean {
  return run(busctlArgv(busctl, name, pids, props, description)) === 0;
}

/** True if systemd moved all pids into the running unit name. */
export function attach(busctl: string, name: string, pids: number[]): boolean {
  return run([busctl, "--user", `--timeout=${BUSCTL_TIMEOUT_S}`, "call",
    "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager", "AttachProcessesToUnit",
    "ssau", name, "", String(pids.length), ...pids.map(String)]) === 0;
}

/** The pids still alive and not in the unit name. */
function outside(root: string, pids: number[], name: string): number[] {
  const out: number[] = [];
  for (const pid of pids) {
    let path: string | null;
    try {
      path = cgroup(root, pid);
    } catch (e) {
      if (e instanceof PyError && e.kind === "OSError") continue; // gone
      throw e;
    }
    if (path !== null && !path.endsWith("/" + name)) out.push(pid);
  }
  return out;
}

/** Poll until pid's cgroup ends in name; the move is asynchronous. */
export function waitAttached(root: string, pid: number, name: string, confirmS = CONFIRM_S): boolean {
  const deadline = performance.now() + confirmS * 1000;
  for (;;) {
    const path = cgroup(root, pid);
    if (path !== null && path.endsWith("/" + name)) return true;
    if (performance.now() >= deadline) return false;
    Bun.sleepSync(10);
  }
}

/** $XDG_RUNTIME_DIR if the user bus socket is in it, else null. */
function userBus(environ: Environ): string | null {
  const runtimeDir = environ["XDG_RUNTIME_DIR"] ?? "";
  return runtimeDir.startsWith("/") && existsSync(pyJoin(runtimeDir, "bus")) ? runtimeDir : null;
}

/** shutil.which("busctl", path=environ PATH) */
export function findBusctl(environ: Environ): string | null {
  const path = environ["PATH"] ?? "";
  if (path === "") return null;
  const seen = new Set<string>();
  for (const dir of path.split(":")) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const name = pyJoin(dir, "busctl");
    try {
      accessSync(name, constants.X_OK);
      if (!statSync(name).isDirectory()) return name;
    } catch {
      // not there, or not executable
    }
  }
  return null;
}

export interface Host {
  /** prefix of /proc, /sys, /var: "" in production */
  root?: string;
  environ?: Environ;
  uid?: number;
  /** uid's login name (null: none); looked up when undefined */
  user?: string | null;
  /** where the ancestor search starts: the hook's parent */
  start?: number;
  /** the hook itself, never moved */
  me?: number;
  confirmS?: number;
}

/** Attach the session process to its scope. Returns a status word. */
export function confine(sessionId: string | null, host: Host = {}): string {
  const root = host.root ?? "", environ = host.environ ?? process.env;
  const uid = host.uid ?? process.getuid?.() ?? -1;
  const start = host.start ?? process.ppid, me = host.me ?? process.pid;
  if (environ["LOADGUARD_CONFINE"] === "0") return "disabled";

  const [pid, chain] = findSession(root, start);
  if (pid === null) return "no-session";
  const path = cgroup(root, pid);
  if (path === null) return "no-cgroup-v2";
  if (inLoadguardScope(path)) return "already";
  if (!lingering(root, host.user !== undefined ? host.user : userName(uid))) return "no-linger";
  const runtimeDir = userBus(environ);
  if (runtimeDir === null) return "no-bus";
  const busctl = findBusctl(environ);
  if (busctl === null) return "no-busctl";
  if (!delegated(root, runtimeDir, uid)) return "no-delegation";
  const props = limits(root, environ);
  if (props === null) return "no-meminfo";

  const name = scopeName(sessionId, pid);
  const description = `loadguard: ${sessionName(root, pid) ?? "None"} session ${sessionId || pid}`;
  if (!startScope(busctl, name, [pid], props, description)) return "start-failed";
  if (!waitAttached(root, pid, name, host.confirmS ?? CONFIRM_S)) return "unconfirmed";
  // Scanned after the move: what the session forks from now on is inside
  // already. The hook and any shell between it and the session exit in a
  // moment.
  const others = outside(root, descendants(root, pid).filter((p) => !chain.includes(p) && p !== me), name);
  if (others.length > 0 && !attach(busctl, name, others))
    for (const other of others) attach(busctl, name, [other]);
  return "attached";
}

// --- the watcher's start -----------------------------------------------------------

/** The loadguard-*.scope a cgroup path ends in, or null. */
export function scopeIn(path: string | null): string | null {
  const name = (path ?? "").split("/").pop() as string;
  return inLoadguardScope(name) ? name : null;
}

/** The pid a scope was made for: loadguard-<session>-<pid>.scope. */
export function owner(scope: string): number | null {
  const m = /-([0-9]+)\.scope\n?$/.exec(scope);
  return m === null ? null : Number(m[1]);
}

export interface Launch {
  root?: string;
  environ?: Environ;
  start?: number;
  /** the watcher entry: dist/watch.js next to this bundle */
  entry?: string;
  /** the Bun to run it with: this one */
  execPath?: string;
}

/**
 * Start the watcher of the session's scope (status is what confine()
 * answered); returns a status word. Detached: own session, stdio on
 * /dev/null, cwd /, never waited for; Bun's isolation flags and without the
 * variables the starters remove; nice 10; after "attached" moved into the
 * scope, which confine() leaves the hook chain outside of.
 */
export function startWatcher(status: string, launch: Launch = {}): string {
  const root = launch.root ?? "", environ = launch.environ ?? process.env;
  const start = launch.start ?? process.ppid;
  const entry = launch.entry ?? import.meta.dir + "/watch.js";
  if (environ["LOADGUARD_LEARN"] === "0") return "disabled";
  if (status !== "attached" && status !== "already") return "not-confined";
  try {
    accessSync(entry, constants.R_OK);
    if (!statSync(entry).isFile()) return "no-entry";
  } catch {
    return "no-entry";
  }
  const [pid] = findSession(root, start);
  const scope = pid !== null && pid !== 0 ? scopeIn(cgroup(root, pid)) : null;
  if (scope === null || pid === null) return "not-confined";
  const env: Environ = { ...environ };
  for (const name of BUN_ENV_REMOVED) delete env[name];
  const child = spawn(launch.execPath ?? process.execPath,
    ["--no-install", "--config=/dev/null", "--no-env-file", entry, String(owner(scope) || pid)],
    { detached: true, stdio: "ignore", cwd: "/", env });
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined) return "spawn-failed";
  try {
    setPriority(child.pid, 10);
  } catch {
    // the watcher sets it itself as well
  }
  const busctl = findBusctl(environ);
  if (status === "attached" && busctl !== null) attach(busctl, scope, [child.pid]);
  return "started";
}
