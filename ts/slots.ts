// Heavy slots: one pass over /proc, processes under app-loadguard.slice.
// Ported from src/loadguard-hook.c (sanitize, read_ppid, learned_shell,
// process_kind, heavy_above, describe, scan_slots).
import { readlinkSync } from "node:fs";
import { type Bytes, cstr, fit, fromBuffer, isDigit, isSpace, pathOf, validUtf8 } from "./bytes.js";
import { base, classify, Harness, Kind, MAX_WORDS, shellCommand, splitArgv } from "./classify.js";
import { getenv } from "./env.js";
import { cut, lessonFor, loadLessons } from "./learned.js";
import { listDir, PATH_MAX, slurp } from "./measure.js";

const SLICE = "app-loadguard.slice";
const SHOWN = 3;        // holders named in a reason
const MAX_DEPTH = 64;   // ancestors followed
const LABEL_SIZE = 48;  // "prove -lr t/"
const HOLDER_SIZE = 160; // "prove -lr t/ in ~/dev/sunriser"
const CMDLINE_SIZE = 1 << 16;
const INT_MAX = 2147483647;

interface Proc {
  pid: number;
  ppid: number;
  kind: Kind;
  label: Bytes;
}

export interface Slots {
  busy: number;
  holders: Bytes[];
}

/** Bytes a reason must not carry: controls, and non-ASCII unless UTF-8. */
export function sanitize(s: Bytes): Bytes {
  const utf8 = validUtf8(s);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x20 || c === 0x7f || (c >= 0x80 && !utf8) ? "?" : s[i];
  }
  return out;
}

/** The ppid after the last ')' of /proc/<pid>/stat, as sscanf(" %*c %d") reads it. */
function readPpid(root: Bytes, pid: number): number | null {
  const raw = slurp(root, "/proc/" + pid + "/stat", 1024);
  if (raw === null || raw.length === 0) return null;
  const buf = cstr(raw);
  let p = buf.lastIndexOf(")");
  if (p < 0) return null;
  p++;
  while (isSpace(buf[p])) p++;
  if (p >= buf.length) return null;
  p++; // %*c
  while (isSpace(buf[p])) p++;
  const m = /^[+-]?[0-9]+/.exec(buf.slice(p));
  if (m === null) return null;
  // glibc: strtol (saturating at the long range), stored as int.
  let v = BigInt(m[0]);
  const LONG = 1n << 63n;
  if (v >= LONG) v = LONG - 1n;
  if (v < -LONG) v = -LONG;
  return Number(BigInt.asIntN(32, v));
}

/** Is argv a shell running a command of the learned list? Then the command, cut to fit. */
function learnedShell(av: Bytes[]): Bytes | null {
  if (loadLessons().lessons.length === 0) return null;
  const cmd = shellCommand(av, Harness.ANY);
  if (cmd === null || lessonFor(cmd) === null) return null;
  return cut(cmd, LABEL_SIZE);
}

/** The kind of a running process by its argv, and its short command. */
function processKind(root: Bytes, pid: number): { kind: Kind; label: Bytes } {
  const none = { kind: Kind.NONE, label: "" };
  const buf = slurp(root, "/proc/" + pid + "/cmdline", CMDLINE_SIZE);
  if (buf === null || buf.length === 0) return none; // gone, a zombie, a kernel thread
  let av = splitArgv(buf, MAX_WORDS);
  // A process title (npm: "npm test", padded with NULs) is one string.
  if (av.length === 1 && (av[0] as Bytes).includes(" "))
    av = (av[0] as Bytes).split(" ").filter((w) => w !== "").slice(0, MAX_WORDS);
  const m = classify(av);
  if (m === null) {
    // A cut-off cmdline has lost the wrapper's ending.
    if (buf.length >= CMDLINE_SIZE - 1) return none;
    const label = learnedShell(av);
    return label === null ? none : { kind: Kind.LEARNED, label };
  }
  let label = fit(base(av[m.at] as Bytes), LABEL_SIZE);
  for (let i = m.at + 1; i < av.length; i++) {
    const arg = av[i] as Bytes;
    if (label.length + 1 + arg.length >= LABEL_SIZE) {
      if (label.length + 4 < LABEL_SIZE) label += " ...";
      break;
    }
    label += " " + arg;
  }
  return { kind: m.kind, label };
}

function holdsSlot(k: Kind): boolean {
  return k !== Kind.NONE && k !== Kind.AGENT;
}

/** "prove -lr t/ in ~/dev/sunriser" */
function describe(root: Bytes, p: Proc): Bytes {
  const path = root + "/proc/" + p.pid + "/cwd";
  let cwd: Bytes | null = null;
  if (path.length < PATH_MAX) {
    try {
      cwd = fromBuffer(readlinkSync(pathOf(path), { encoding: "buffer" })).slice(0, PATH_MAX - 1);
    } catch {
      cwd = null;
    }
  }
  let out: Bytes;
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
    if (out.length >= HOLDER_SIZE) out = out.slice(0, HOLDER_SIZE - 4) + "...";
  }
  return sanitize(out);
}

export function scanSlots(root: Bytes): Slots {
  const sl: Slots = { busy: 0, holders: [] };
  const names = listDir(root, "/proc");
  if (names === null) return sl;
  const ps: Proc[] = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const big = BigInt(name);
    if (big <= 0n || big > BigInt(INT_MAX)) continue;
    const pid = Number(big);
    const cgroup = slurp(root, "/proc/" + pid + "/cgroup", 4096);
    if (cgroup === null || cgroup.length === 0 || !cstr(cgroup).includes("/" + SLICE + "/")) continue;
    const ppid = readPpid(root, pid);
    if (ppid === null) continue;
    ps.push({ pid, ppid, ...processKind(root, pid) });
  }
  ps.sort((a, b) => a.pid - b.pid);
  const byPid = new Map<number, Proc>();
  for (const p of ps) if (!byPid.has(p.pid)) byPid.set(p.pid, p);
  const heavyAbove = (p: Proc): boolean => {
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const up = byPid.get(p.ppid);
      if (up === undefined) return false;
      if (holdsSlot(up.kind)) return true;
      p = up;
    }
    return false;
  };
  for (const p of ps) {
    if (!holdsSlot(p.kind) || heavyAbove(p)) continue;
    if (sl.holders.length < SHOWN) sl.holders.push(describe(root, p));
    sl.busy++;
  }
  return sl;
}
