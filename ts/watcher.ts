// The watcher of a session scope (k15), ported from `--watch PID` of
// src/loadguard-hook.c (read_stat, read_rss, harness_of, scope_of, make_dirs,
// set_item, write_lessons, learned_update, run_command, start_run, end_run,
// top_shell, watch_tick, watch_setup, watch_lock, watch, driver_watch).
//
// One watcher per scope, the process the scope was made for given as PID.
// Every TICK_S it reads the scope's cgroup.procs and, per process, stat and
// statm; a Bash call (the topmost shell under the session process) whose
// processes hold LOADGUARD_LEARN_RSS % of MemTotal between them is written to
// the learned list at once, again when its peak grew by 10 %, and once when
// its shell ends. Its cmdline is read once, when it first crosses the limit.
// It ends as soon as the session process is gone (or its start time changed,
// or the scope's cgroup.procs is gone); it never spins and prints nothing.
//
// The list keeps its format and its lock: flock on learned.lock, the whole
// list into <list>.<pid>.tmp, fsync, rename, fsync of the directory — so C
// watchers still running from before the update and `loadguard forget`
// write alongside.
import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeSync, constants } from "node:fs";
import { setPriority } from "node:os";
import { type Bytes, cstr, fit, fromBuffer, isDigit, isSpace, pathOf, toBuffer, u64, validUtf8 } from "./bytes.js";
import { base, Harness, heavyCommand, MAX_WORDS, SHELLS, shellCommand, splitArgv } from "./classify.js";
import { get, jnum, jobj, jstr, type JValue, print, str } from "./cjson.js";
import { LEARN_RSS_DEFAULT, limit } from "./decide.js";
import { getenv } from "./env.js";
import { LEARNED_BYTES, LEARNED_FILE, learnOff, lessonObjects, readRegular, stateFile } from "./learned.js";
import { lockFile } from "./lock.js";
import { meminfo, PATH_MAX, slurp } from "./measure.js";
import { sanitize } from "./slots.js";

export const TICK_S = 2;
const RUNS = 16;                 // calls over the limit tracked at once
const MAX_DEPTH = 64;            // ancestors followed
const LEARNED_LOCK = "learned.lock";
const LEARNED_MAX = 100;         // entries the watcher keeps
const LEARN_COMMAND_MAX = 4096;  // longer commands are not learned
const INT_MAX = 2147483647;
const LONG_MAX = (1n << 63n) - 1n, LONG_MIN = -(1n << 63n), ULL_MAX = (1n << 64n) - 1n;

interface WProc {
  pid: number;
  ppid: number;
  shell: boolean;
  start: bigint;
  rss: bigint;
  sum: bigint;
}

/** A Bash call over the limit. learning false: not learned, cmdline read. */
interface Run {
  pid: number;
  learning: boolean;
  start: bigint;
  peak: bigint;
  written: bigint;
  command: Bytes | null;
  cwd: Bytes;
}

export interface Watch {
  root: Bytes;
  session: number;
  self: number;
  /** the session process's start time */
  since: bigint;
  harness: Harness;
  /** the scope's cgroup.procs */
  procs: Bytes;
  /** bytes */
  limit: bigint;
  page: bigint;
  runs: Run[];
  /** the test driver's log: one JSON line per thing done; null in production */
  log: Bytes[] | null;
  pass: number;
}

// --- C's number scanning -----------------------------------------------------------

/** strtol(s + i, &end, 10): the value (saturated to long) and end (i if none). */
export function strtol(s: Bytes, i: number): { v: bigint; end: number } {
  let p = i;
  while (isSpace(s[p])) p++;
  let neg = false;
  if (s[p] === "+" || s[p] === "-") neg = s[p++] === "-";
  const q = p;
  while (isDigit(s[p])) p++;
  if (p === q) return { v: 0n, end: i };
  let v = BigInt(s.slice(q, p));
  if (neg) v = -v;
  return { v: v > LONG_MAX ? LONG_MAX : v < LONG_MIN ? LONG_MIN : v, end: p };
}

/** sscanf's integer conversions on a C string: whitespace, sign, digits. */
class Scan {
  p = 0;
  constructor(readonly s: Bytes) {}
  ws(): void {
    while (isSpace(this.s[this.p])) this.p++;
  }
  /** %*c */
  char(): boolean {
    if (this.p >= this.s.length) return false;
    this.p++;
    return true;
  }
  /** %*s */
  word(): boolean {
    this.ws();
    const q = this.p;
    while (this.p < this.s.length && !isSpace(this.s[this.p])) this.p++;
    return this.p > q;
  }
  private digits(): { neg: boolean; v: bigint } | null {
    this.ws();
    let p = this.p, neg = false;
    if (this.s[p] === "+" || this.s[p] === "-") neg = this.s[p++] === "-";
    const q = p;
    while (isDigit(this.s[p])) p++;
    if (p === q) return null;
    this.p = p;
    return { neg, v: BigInt(this.s.slice(q, p)) };
  }
  /** %d: strtol, stored as int */
  int(): number | null {
    const d = this.digits();
    if (d === null) return null;
    let v = d.neg ? -d.v : d.v;
    v = v > LONG_MAX ? LONG_MAX : v < LONG_MIN ? LONG_MIN : v;
    return Number(BigInt.asIntN(32, v));
  }
  /** %llu: strtoull, a sign negates modulo 2^64, overflow saturates */
  ull(): bigint | null {
    const d = this.digits();
    if (d === null) return null;
    if (d.v > ULL_MAX) return ULL_MAX;
    return d.neg ? u64(-d.v) : d.v;
  }
}

// --- /proc -------------------------------------------------------------------------

interface Stat {
  comm: Bytes;
  ppid: number;
  start: bigint;
}

/** comm, ppid and start time from /proc/<pid>/stat (proc(5): fields 2, 4, 22). */
function readStat(root: Bytes, pid: number): Stat | null {
  const raw = slurp(root, "/proc/" + pid + "/stat", 1024);
  if (raw === null || raw.length === 0) return null;
  const buf = cstr(raw);
  const open = buf.indexOf("("), close = buf.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  // "%.*s" with a negative precision prints the whole string.
  const comm = fit(close - open - 1 >= 0 ? buf.slice(open + 1, close) : buf.slice(open + 1), 64);
  // " %*c %d %*s x17 %llu"
  const sc = new Scan(buf.slice(close + 1));
  sc.ws();
  if (!sc.char()) return null;
  const ppid = sc.int();
  if (ppid === null) return null;
  for (let i = 0; i < 17; i++) if (!sc.word()) return null;
  const start = sc.ull();
  return start === null ? null : { comm, ppid, start };
}

/** Resident bytes from /proc/<pid>/statm. */
function readRss(w: Watch, pid: number): bigint | null {
  const raw = slurp(w.root, "/proc/" + pid + "/statm", 256);
  if (raw === null || raw.length === 0) return null;
  const sc = new Scan(cstr(raw));
  if (!sc.word()) return null;
  const pages = sc.ull();
  return pages === null ? null : u64(pages * w.page);
}

/** The page size from the auxiliary vector (AT_PAGESZ), else 4096. */
function pageSize(): bigint {
  try {
    const auxv = readFileSync("/proc/self/auxv");
    for (let i = 0; i + 16 <= auxv.length; i += 16) {
      const type = auxv.readBigUInt64LE(i);
      if (type === 0n) break;
      if (type === 6n) return auxv.readBigUInt64LE(i + 8);
    }
  } catch {
    // no /proc
  }
  return 4096n;
}

/** Claude Code or Codex by comm or argv[0], as confine.py's session_name. */
function harnessOf(root: Bytes, pid: number, comm: Bytes): Harness {
  let name = comm;
  if (name !== "claude" && name !== "codex") {
    const raw = slurp(root, "/proc/" + pid + "/cmdline", 4096);
    if (raw === null || raw.length === 0) return Harness.ANY;
    name = base(cstr(raw));
  }
  return name === "claude" ? Harness.CLAUDE : name === "codex" ? Harness.CODEX : Harness.ANY;
}

/** The loadguard-*.scope pid is in: its cgroup.procs below /sys/fs/cgroup, its name. */
function scopeOf(root: Bytes, pid: number): { procs: Bytes; name: Bytes } | null {
  const raw = slurp(root, "/proc/" + pid + "/cgroup", 4096);
  if (raw === null || raw.length === 0) return null;
  const buf = cstr(raw);
  let p = 0;
  while (!buf.startsWith("0::", p)) {
    const nl = buf.indexOf("\n", p);
    if (nl < 0) return null;
    p = nl + 1;
  }
  const nl = buf.indexOf("\n", p);
  const line = nl < 0 ? buf.slice(p) : buf.slice(p, nl);
  const slash = line.lastIndexOf("/");
  if (slash < 0) return null;
  const name = line.slice(slash + 1);
  if (!name.startsWith("loadguard-") || name.length <= 16 || !name.endsWith(".scope")) return null;
  const procs = "/sys/fs/cgroup" + line.slice(3) + "/cgroup.procs";
  return procs.length < PATH_MAX && name.length < 256 ? { procs, name } : null;
}

// --- the learned list --------------------------------------------------------------

/** Every missing directory above file, mode 0700; false if the last fails. */
function makeDirs(file: Bytes): boolean {
  if (file.length >= PATH_MAX) return false;
  const s = file.lastIndexOf("/");
  if (s <= 0) return false;
  const dir = file.slice(0, s);
  for (let i = 1; i < dir.length; i++) {
    if (dir[i] !== "/") continue;
    try {
      mkdirSync(pathOf(dir.slice(0, i)), { mode: 0o700 });
    } catch {
      // there already, or not ours to make
    }
  }
  try {
    mkdirSync(pathOf(dir), { mode: 0o700 });
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EEXIST";
  }
}

/** Replace the object's key in place, or add it. */
function setItem(o: JValue, key: Bytes, item: JValue): void {
  if (o.t !== "obj") return;
  const at = o.items.findIndex(([k]) => k === key);
  if (at >= 0) (o.items[at] as [Bytes, JValue])[1] = item;
  else o.items.push([key, item]);
}

function lastSeen(o: JValue): Bytes {
  return str(get(o, "last_seen")) ?? "";
}

function writeAll(fd: number, data: Buffer): void {
  for (let off = 0; off < data.length;) off += writeSync(fd, data, off, data.length - off);
}

/** The whole list into path.<pid>.tmp, synced, renamed over path. */
function writeLessons(path: Bytes, all: JValue[]): void {
  const tmp = path + "." + process.pid + ".tmp";
  let fd: number;
  try {
    fd = openSync(pathOf(tmp), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  } catch {
    return;
  }
  let ok = true;
  try {
    writeAll(fd, toBuffer(all.map((o) => print(o) + "\n").join("")));
    fsyncSync(fd);
  } catch {
    ok = false;
  }
  try {
    closeSync(fd);
  } catch {
    ok = false;
  }
  try {
    if (!ok) throw new Error("write");
    renameSync(pathOf(tmp), pathOf(path));
  } catch {
    try {
      unlinkSync(pathOf(tmp));
    } catch {
      // gone already
    }
    return;
  }
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    try {
      const dfd = openSync(pathOf(path.slice(0, slash)), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // the rename stands
    }
  }
}

/** gmtime + strftime("%Y-%m-%dT%H:%M:%SZ") */
function stamp(now: number): Bytes {
  return new Date(now * 1000).toISOString().slice(0, 19) + "Z";
}

/**
 * Record a run in the list under flock: its peak (the highest ever seen for
 * the command), cwd and last_seen; first_seen when new. Above LEARNED_MAX
 * entries the one longest not seen big goes. An oversized or broken list is
 * replaced; lines that are no entry are dropped.
 */
function learnedUpdate(r: Run, now: number): void {
  const path = stateFile(LEARNED_FILE), lockPath = stateFile(LEARNED_LOCK);
  if (path === null || lockPath === null || !makeDirs(lockPath)) return;
  let lock: number;
  try {
    lock = openSync(pathOf(lockPath), constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch {
    return;
  }
  try {
    if (!lockFile(lock, false)) return;
    const { buf } = readRegular(path, LEARNED_BYTES);
    const all = buf === null ? [] : lessonObjects(buf);
    const when = stamp(now), command = r.command as Bytes;
    let hit = all.find((o) => str(get(o, "command")) === command);
    if (hit === undefined) {
      hit = jobj([["command", jstr(command)]]);
      all.push(hit);
    }
    const peak = get(hit, "peak_rss"), mine = Number(r.peak);
    setItem(hit, "peak_rss", jnum(peak !== null && peak.t === "num" && peak.v > mine ? peak.v : mine));
    setItem(hit, "cwd", jstr(r.cwd));
    if (get(hit, "first_seen") === null) setItem(hit, "first_seen", jstr(when));
    setItem(hit, "last_seen", jstr(when));
    while (all.length > LEARNED_MAX) {
      let oldest = 0;
      for (let i = 1; i < all.length; i++)
        if (lastSeen(all[i] as JValue) < lastSeen(all[oldest] as JValue)) oldest = i;
      all.splice(oldest, 1);
    }
    writeLessons(path, all);
  } finally {
    closeSync(lock); // releases the flock
  }
}

// --- runs ----------------------------------------------------------------------------

function logRun(w: Watch, event: string, r: { pid: number; peak: bigint; command: Bytes | null }, why: string | null): void {
  if (w.log === null) return;
  const o: [Bytes, JValue][] = [["tick", jnum(w.pass)], ["event", jstr(event)], ["pid", jnum(r.pid)],
    ["peak", jnum(Number(r.peak))]];
  if (r.command !== null) o.push(["command", jstr(r.command)]);
  if (why !== null) o.push(["why", jstr(why)]);
  w.log.push(print(jobj(o)) + "\n");
}

function record(w: Watch, r: Run, now: number, event: string): void {
  learnedUpdate(r, now);
  r.written = r.peak;
  logRun(w, event, r, null);
}

/**
 * The command of a shell over the limit, or null and why: its cmdline is read
 * here, once. Not learned: a form the harness does not use, an empty,
 * overlong or non-UTF-8 command, one the fixed list calls heavy already.
 */
function runCommand(w: Watch, pid: number): { cmd: Bytes | null; why: string } {
  const size = 1 << 18;
  const buf = slurp(w.root, "/proc/" + pid + "/cmdline", size);
  if (buf === null || buf.length === 0 || buf.length >= size - 1) return { cmd: null, why: "cmdline" };
  const cmd = shellCommand(splitArgv(buf, MAX_WORDS), w.harness);
  if (cmd === null) return { cmd: null, why: "form" };
  if (cmd.length === 0 || cmd.length > LEARN_COMMAND_MAX || !validUtf8(cmd)) return { cmd: null, why: "text" };
  if (heavyCommand(cmd) !== null) return { cmd: null, why: "fixed" };
  return { cmd, why: "" };
}

function startRun(w: Watch, sh: WProc, now: number): void {
  if (w.runs.length === RUNS) {
    logRun(w, "skip", { pid: sh.pid, peak: sh.sum, command: null }, "full");
    return;
  }
  const r: Run = { pid: sh.pid, learning: false, start: sh.start, peak: sh.sum, written: 0n, command: null, cwd: "" };
  w.runs.push(r);
  const { cmd, why } = runCommand(w, sh.pid);
  if (cmd === null) {
    logRun(w, "skip", r, why);
    return;
  }
  r.command = cmd;
  // C reads the link through a 64-byte path: a long root loses it.
  const path = fit(w.root + "/proc/" + sh.pid + "/cwd", 64);
  try {
    r.cwd = fromBuffer(readlinkSync(pathOf(path), { encoding: "buffer" })).slice(0, PATH_MAX - 1);
  } catch {
    r.cwd = "";
  }
  r.cwd = sanitize(cstr(r.cwd));
  r.learning = true;
  record(w, r, now, "learn");
}

/** The last word on a run whose shell ended; drops it (the last takes its place). */
function endRun(w: Watch, i: number, now: number): void {
  const r = w.runs[i] as Run;
  if (r.learning) record(w, r, now, "end");
  w.runs[i] = w.runs[w.runs.length - 1] as Run;
  w.runs.pop();
}

/** glibc's bsearch over ps sorted by pid: the index, or -1. */
function findW(ps: WProc[], pid: number): number {
  let l = 0, u = ps.length;
  while (l < u) {
    const idx = (l + u) >> 1, other = (ps[idx] as WProc).pid;
    if (pid < other) u = idx;
    else if (pid > other) l = idx + 1;
    else return idx;
  }
  return -1;
}

/** The topmost shell between ps[i] and the session process; -1 if none, or
 * if it is not below the session (an orphan whose shell is gone). */
function topShell(ps: WProc[], i: number, session: number): number {
  let top = -1, p = i;
  for (let depth = 0; depth < MAX_DEPTH && (ps[p] as WProc).pid !== session; depth++) {
    const proc = ps[p] as WProc;
    if (proc.shell) top = p;
    if (proc.ppid === session) return top;
    if ((p = findW(ps, proc.ppid)) < 0) return -1;
  }
  return -1;
}

/** One look at the scope; false once the session process is gone. */
export function watchTick(w: Watch, now: number): boolean {
  const st = readStat(w.root, w.session);
  const buf = st === null || st.start !== w.since ? null : slurp(w.root, w.procs, 1 << 16);
  if (buf === null) {
    while (w.runs.length > 0) endRun(w, w.runs.length - 1, now);
    return false;
  }
  const text = cstr(buf), ps: WProc[] = [];
  for (let p = 0; ;) {
    const { v, end } = strtol(text, p);
    if (end === p) break;
    p = end;
    if (v <= 0n || v > BigInt(INT_MAX) || v === BigInt(w.self)) continue;
    const pid = Number(v), s = readStat(w.root, pid);
    const rss = s === null ? null : readRss(w, pid);
    if (s === null || rss === null) continue; // gone meanwhile
    ps.push({ pid, ppid: s.ppid, shell: SHELLS.includes(s.comm), start: s.start, rss, sum: 0n });
  }
  ps.sort((a, b) => a.pid - b.pid);
  for (let i = 0; i < ps.length; i++) {
    const top = topShell(ps, i, w.session);
    if (top >= 0) (ps[top] as WProc).sum = u64((ps[top] as WProc).sum + (ps[i] as WProc).rss);
  }
  for (let j = w.runs.length - 1; j >= 0; j--) {
    const r = w.runs[j] as Run, at = findW(ps, r.pid);
    if (at < 0 || (ps[at] as WProc).start !== r.start) {
      endRun(w, j, now);
      continue;
    }
    const sh = ps[at] as WProc;
    if (sh.sum > r.peak) r.peak = sh.sum;
    if (r.learning && r.peak >= r.written + r.written / 10n) record(w, r, now, "grow");
  }
  for (const sh of ps) {
    if (!sh.shell || sh.sum < w.limit) continue;
    if (!w.runs.some((r) => r.pid === sh.pid && r.start === sh.start)) startRun(w, sh, now);
  }
  return true;
}

/** The scope pid was confined in, the harness, the limit; null if any is
 * missing: then there is nothing to watch. */
export function watchSetup(root: Bytes, pid: number, log: Bytes[] | null): { w: Watch; scope: Bytes } | null {
  const st = readStat(root, pid);
  if (st === null) return null;
  const harness = harnessOf(root, pid, st.comm);
  if (harness === Harness.ANY) return null;
  const sc = scopeOf(root, pid);
  if (sc === null) return null;
  const buf = slurp(root, "/proc/meminfo", 8192);
  const total = buf === null || buf.length === 0 ? null : meminfo(cstr(buf), "MemTotal:");
  if (total === null || total === 0n) return null;
  const w: Watch = {
    root, session: pid, self: process.pid, since: st.start, harness, procs: sc.procs,
    limit: u64(u64(u64(total * 1024n) / 100n) * BigInt(limit("learnRss", LEARN_RSS_DEFAULT))),
    page: pageSize(), runs: [], log, pass: 0,
  };
  return { w, scope: sc.name };
}

/**
 * One watcher per scope: flock on $XDG_RUNTIME_DIR/loadguard/<scope>.watch,
 * which holds its pid (for doctor). null if another holds it or there is no
 * runtime dir: a resumed session, a nested claude -p, an app-server thread
 * find the scope watched already.
 */
export function watchLock(scope: Bytes): { fd: number; path: Bytes } | null {
  const run = getenv("XDG_RUNTIME_DIR");
  if (run === null || run[0] !== "/") return null;
  const path = run + "/loadguard/" + scope + ".watch";
  if (path.length >= PATH_MAX || !makeDirs(path)) return null;
  let fd: number;
  try {
    fd = openSync(pathOf(path), constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch {
    return null;
  }
  if (!lockFile(fd, true)) {
    closeSync(fd);
    return null;
  }
  try {
    ftruncateSync(fd, 0);
    writeAll(fd, toBuffer(process.pid + "\n"));
  } catch {
    // doctor will not find it; the lock still holds
  }
  return { fd, path };
}

export function watchUnlock(lock: { fd: number; path: Bytes }): void {
  try {
    unlinkSync(pathOf(lock.path));
  } catch {
    // gone already
  }
  closeSync(lock.fd);
}

/** watch.js PID: until the session process is gone. */
export function watch(arg: string): void {
  const { v, end } = strtol(arg, 0);
  if (arg === "" || end !== arg.length || v <= 1n || v > BigInt(INT_MAX) || learnOff()) return;
  try {
    process.chdir("/");
  } catch {
    return;
  }
  try {
    setPriority(10);
  } catch {
    // runs at the nice it has
  }
  const setup = watchSetup("", Number(v), null);
  if (setup === null) return;
  const lock = watchLock(setup.scope);
  if (lock === null) return;
  while (watchTick(setup.w, Math.floor(Date.now() / 1000))) Bun.sleepSync(TICK_S * 1000);
  watchUnlock(lock);
}
