// bin/loadguard (k5, k15): status, doctor, explain, learned, forget, help —
// ported from lib/loadguard/cli.py. The decisions are not made here: status
// and explain call the report modes of ts/report.ts (the hook's own code,
// what `loadguard-hook --report` / `--explain` print) in this process and
// format their JSON as cli.py does. Nothing here classifies a command, scans
// /proc for slots or holds a figure against a limit.
//
// Deliberate differences from cli.py (listed on k22):
// - Arguments are positional only (getty-bun: no entry argument begins with
//   "-"): `help`, `forget all`; `explain` with no command reads it from
//   stdin, the only way to pass one that starts with "-".
// - No hook binary and no data directory: the report is computed in-process,
//   so the pass-through and "no report mode" answers are gone, and status's
//   hook line names this bundle.
// - doctor checks the Bun runtime (the version this runs on against the pin,
//   the getty-bun slot) instead of the binary, its build and the compiler;
//   the learning section is never "unknown". The watcher check knows the TS
//   watcher (dist/watch.js) beside the C one.
import { type Bytes, fixed, toBuffer, utf8Bytes } from "./bytes.js";
import { jobj, jstr, type JValue } from "./cjson.js";
import * as learn from "./learnlist.js";
import { reportExplain, reportStatus } from "./report.js";
import {
  cgroup, controllersPath, DEFAULTS, delegated, type Environ, envInt, findBusctl, findSession,
  inLoadguardScope, limits as scopeLimits, lingering, memTotal, PyError, userBus, userName,
} from "./scope.js";
import { findSlot, PIN } from "./slot.js";

const REPORT_FORMAT = 1;
const LABEL = 9; // "session: "

/** Where the CLI looks; tests point it at a fixture tree. */
export interface Where {
  /** prefix of /proc, /sys, /var: "" on the live host */
  root?: string;
  uid?: number;
  /** this process, for the cgroup v2 check */
  me?: number;
  /** where the search for the session starts: the parent */
  start?: number;
  /** the bundle, for status's hook line */
  self?: string;
}

export interface Result {
  rc: number;
  stdout: string;
  stderr: string;
}

// --- the reports ----------------------------------------------------------------

interface Pressure {
  full: number | null;
  some: number | null;
  swap: number | null;
  zram: number | null;
}

interface Doc {
  report: number;
  throttle: boolean;
  ignored: string[];
  limits: { psi_full: number; swap_used: number; slots: number };
  pressure: Pressure;
  pressured: boolean;
  slots: { busy: number; holders: string[] } | null;
  refuse_heavy: boolean;
  learn: { on: boolean; file: string | null; state: string; entries: number; rss_limit: number };
  bash: boolean;
  heavy: string | null;
  decision: string;
  reason: string | null;
}

/** The JSON a report mode printed, read as cli.py reads the binary's. */
function doc(bytes: Bytes): Doc {
  const d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(toBuffer(bytes))) as Doc;
  if (typeof d !== "object" || d === null || d.report !== REPORT_FORMAT) throw new Error("no report: " + bytes);
  return d;
}

/** The hook payload Claude Code would send for this Bash command. */
function payload(command: Bytes): JValue {
  return jobj([["hook_event_name", jstr("PreToolUse")], ["tool_name", jstr("Bash")],
    ["tool_input", jobj([["command", jstr(command)]])]]);
}

// --- Python's formatting ----------------------------------------------------------

const NONPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

function hex(c: number, n: number): string {
  return c.toString(16).padStart(n, "0");
}

/** Python's \xNN / \uNNNN / \UNNNNNNNN for a non-ASCII code point. */
function backslash(c: number): string {
  return c <= 0xff ? "\\x" + hex(c, 2) : c <= 0xffff ? "\\u" + hex(c, 4) : "\\U" + hex(c, 8);
}

/** repr() of a str. */
export function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === q || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + hex(c, 2);
    else if (c > 0x7f && NONPRINTABLE.test(ch)) out += backslash(c);
    else out += ch;
  }
  return out + q;
}

/** "%d" of a number */
function d(n: number): string {
  return String(Math.trunc(n));
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// --- the session -----------------------------------------------------------------

/** [session pid, its cgroup path]: pid null outside a session, path null without cgroup v2. */
function session(root: string, start: number): [number | null, string | null] {
  try {
    const [pid] = findSession(root, start);
    return [pid, pid ? cgroup(root, pid) : null];
  } catch (e) {
    if (e instanceof PyError) return [null, null];
    throw e;
  }
}

/** The loadguard-*.scope in a cgroup path, or null. */
function scopeOf(path: string | null): string | null {
  for (const part of (path ?? "").split("/")) if (inLoadguardScope(part)) return part;
  return null;
}

function sessionText(pid: number | null, path: string | null): string {
  if (pid === null) return "not run from a Claude Code or Codex session";
  const scope = scopeOf(path);
  if (scope !== null) return "confined in " + scope;
  return `not confined (cgroup ${path ?? "n/a"})`;
}

// --- formatting --------------------------------------------------------------------

/** "label:  first line", the others indented below it. */
function rows(label: string, lines: string[]): string[] {
  return lines.map((line, i) => (i === 0 ? (label + ":").padEnd(LABEL) : " ".repeat(LABEL)) + line);
}

function percent(value: number | null, digits = 0): string {
  return value === null ? "n/a" : fixed(value, digits) + "%";
}

function memory(doc: Doc): string {
  const p = doc.pressure, lim = doc.limits;
  let text = `PSI full ${percent(p.full, 2)} (limit ${d(lim.psi_full)}%), some ${percent(p.some, 2)}; ` +
    `swap ${percent(p.swap)} used (limit ${d(lim.swap_used)}%)`;
  if (p.zram !== null) text += `; zram ${d(p.zram)}% full`;
  return text;
}

function slotLines(doc: Doc): string[] {
  const slots = doc.slots;
  if (slots === null)
    return ["not scanned: under memory pressure the hook reads no other",
      "process (that can stall on swap); pressure alone refuses"];
  const lines = [`${d(slots.busy)}/${d(doc.limits.slots)} heavy busy`, ...slots.holders];
  if (slots.busy > slots.holders.length) lines.push(`+${d(slots.busy - slots.holders.length)} more`);
  return lines;
}

function ignoredLines(names: string[], environ: Environ): string[] {
  return names.map((name) => {
    const value = pyRepr(environ[name] ?? "");
    return ["LOADGUARD_THROTTLE", "LOADGUARD_CONFINE", "LOADGUARD_LEARN"].includes(name)
      ? `${name}=${value} changes nothing: only 0 turns it off`
      : `${name}=${value} is not valid: the default applies`;
  });
}

function heavyNow(doc: Doc): string {
  if (!doc.throttle) return "never refused: LOADGUARD_THROTTLE=0";
  if (!doc.refuse_heavy) return "a heavy command would run now";
  return `a heavy command would be refused now (${doc.pressured ? "memory pressure" : "all heavy slots busy"})`;
}

function formatStatus(doc: Doc, environ: Environ, sessionLine: string, hookLine: string): string[] {
  return [...rows("memory", [memory(doc)]), ...rows("slots", slotLines(doc)),
    ...rows("heavy", [heavyNow(doc)]), ...rows("ignored", ignoredLines(doc.ignored, environ)),
    ...rows("session", [sessionLine]), ...rows("hook", [hookLine])];
}

function formatExplain(doc: Doc, environ: Environ): string[] {
  const lines = rows("ignored", ignoredLines(doc.ignored, environ));
  if (!doc.bash)
    return [...lines, ...rows("verdict", ["allow: not a Bash payload the hook can read; it passes it through"])];
  if (!doc.throttle) {
    lines.push(...rows("heavy", ["not checked: LOADGUARD_THROTTLE=0"]));
  } else if (doc.heavy === null) {
    lines.push(...rows("heavy", ["no: no heavy pattern, not learned; a light command is never refused"]));
  } else {
    lines.push(...rows("heavy", [`yes (${doc.heavy})`]), ...rows("memory", [memory(doc)]),
      ...rows("slots", slotLines(doc)));
  }
  if (doc.decision === "deny")
    return [...lines, ...rows("verdict", ["deny; the model is told:", ...(doc.reason ?? "").split("\n")])];
  return [...lines, ...rows("verdict", ["allow: the hook stays silent, the command runs"])];
}

// --- status, explain -----------------------------------------------------------------

interface Ctx {
  root: string;
  uid: number;
  me: number;
  start: number;
  self: string;
  environ: Environ;
}

function status(c: Ctx): Result {
  const here = sessionText(...session(c.root, c.start));
  const lines = formatStatus(doc(reportStatus(c.root)), c.environ, here,
    `decided in-process by ${c.self}, the hook's own code`);
  return { rc: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function explain(c: Ctx, command: Bytes): Result {
  const lines = formatExplain(doc(reportExplain(c.root, payload(command))), c.environ);
  return { rc: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

// --- learned, forget (k15) --------------------------------------------------------------

/** One line of ASCII: a backslash doubled, controls as \n, \t or \xNN, other non-ASCII backslash-escaped. */
export function shown(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + hex(c, 2);
    else if (c < 0x80) out += ch;
    else out += backslash(c);
  }
  return out;
}

function homeShort(path: string, environ: Environ): string {
  const home = environ["HOME"] ?? "";
  if (home.length > 1 && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

function size(n: number): string {
  return n >= 2 ** 30 ? fixed(n / 2 ** 30, 1) + " GiB" : d(Math.floor(n / 2 ** 20)) + " MiB";
}

function entryLines(n: number, entry: learn.Entry, environ: Environ): string[] {
  // isinstance(True, int) in Python: a boolean counts as 0 or 1.
  const raw = entry["peak_rss"], peak = typeof raw === "boolean" ? Number(raw) : raw;
  const last = entry["last_seen"], cwd = entry["cwd"];
  let head = `${String(n).padStart(3)}  ${typeof peak === "number" && peak > 0 ? size(peak) : "? MiB"}  last ` +
    (typeof last === "string" ? shown(Array.from(last).slice(0, 10).join("")) : "?");
  if (typeof cwd === "string" && cwd !== "") head += "  in " + shown(homeShort(cwd, environ));
  return [head, "     " + shown(entry["command"] as string)];
}

function learned(environ: Environ): Result {
  const path = learn.listPath(environ);
  if (path === null)
    return { rc: 1, stdout: "learned: no list: neither $XDG_STATE_HOME nor $HOME is an absolute path\n", stderr: "" };
  const [entries, problem] = learn.read(path);
  const lines: string[] = [];
  if (learn.disabled(environ)) lines.push("learning is off (LOADGUARD_LEARN=0): the hook ignores this list");
  if (problem === "too-large") {
    lines.push(`${path} is larger than ${learn.MAX_BYTES} bytes: the hook ignores it; \`loadguard forget all\` clears it`);
  } else if (problem !== null) {
    lines.push(`${path} cannot be read: ${problem}`);
  } else if (entries.length === 0) {
    lines.push(`no learned commands (${path})`);
  } else {
    lines.push(`${entries.length} learned command${plural(entries.length)} in ${path}; each exact text is heavy:`);
    entries.forEach((entry, i) => lines.push(...entryLines(i + 1, entry, environ)));
  }
  return { rc: problem !== null ? 1 : 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function forget(environ: Environ, args: string[]): Result {
  const path = learn.listPath(environ);
  if (path === null)
    return { rc: 1, stdout: "forget: no list: neither $XDG_STATE_HOME nor $HOME is an absolute path\n", stderr: "" };
  let numbers: number[] | null;
  if (args.length === 1 && args[0] === "all") numbers = null;
  else if (args.every((a) => /^[1-9][0-9]{0,5}$/.test(a))) numbers = [...new Set(args.map(Number))].sort((a, b) => a - b);
  else return usage(2);
  let dropped: learn.Entry[];
  try {
    dropped = learn.forget(path, numbers);
  } catch (e) {
    const text = e instanceof learn.ForgetError ? e.message : learn.strerror(e);
    return { rc: 1, stdout: `forget: ${text}; nothing changed\n`, stderr: "" };
  }
  const lines = dropped.length === 0 ? [`nothing to forget (${path})`] : [];
  for (const entry of dropped) lines.push("forgot: " + shown(entry["command"] as string));
  return { rc: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

// --- doctor --------------------------------------------------------------------------------

type Check = [state: "ok" | "--" | "FAIL", text: string, hint: string | null];
type Section = [title: string, checks: Check[]];

function asOSError<T>(f: () => T, otherwise: T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof PyError && e.kind === "OSError") return otherwise;
    throw e;
  }
}

/** Stage 1 variables that are set and change nothing (confine.py). */
function confineIgnored(environ: Environ): string[] {
  const names: string[] = [];
  if ("LOADGUARD_CONFINE" in environ && environ["LOADGUARD_CONFINE"] !== "0") names.push("LOADGUARD_CONFINE");
  for (const [, name, , lo, hi] of DEFAULTS)
    if (name in environ && envInt(environ, name, -1, lo, hi) === -1) names.push(name);
  return names;
}

/** Stage 1 as confine() sees it. */
function stage1(c: Ctx): Section {
  const environ = c.environ, off = environ["LOADGUARD_CONFINE"] === "0";
  const bad = off ? "--" : "FAIL";
  const out: Check[] = [];
  const v2 = asOSError(() => cgroup(c.root, c.me) !== null, false);
  out.push(v2 ? ["ok", "cgroup v2", null] : [bad, "no cgroup v2", "confinement needs the unified hierarchy"]);
  const runtimeDir = userBus(environ), busctl = findBusctl(environ);
  out.push(runtimeDir !== null && busctl !== null
    ? ["ok", `user bus in ${runtimeDir}, ${busctl}`, null]
    : [bad, runtimeDir === null ? "no user bus ($XDG_RUNTIME_DIR/bus)" : "no busctl on PATH",
      "confinement talks to systemd --user"]);
  let isDelegated = false;
  if (runtimeDir !== null) {
    isDelegated = asOSError(() => delegated(c.root, runtimeDir, c.uid), false);
    out.push(isDelegated ? ["ok", `memory controller delegated to user@${c.uid}.service`, null]
      : [bad, `memory controller not delegated to user@${c.uid}.service`, "see " + controllersPath(c.uid)]);
  } else {
    out.push(["--", "delegation not checked without a user bus", null]);
  }
  const name = userName(c.uid);
  const user = name ?? String(c.uid);
  const linger = lingering(c.root, name);
  out.push(linger ? ["ok", "linger for " + user, null]
    : [bad, "no linger for " + user, "loginctl enable-linger; without it sessions stay unconfined"]);
  const lim = asOSError(() => scopeLimits(c.root, environ), null);
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
    out.push([works && !off ? "FAIL" : "--", "this session: " + sessionText(pid, path),
      works && !off ? "sessions are confined when they start; start a new one" : null]);
  }
  return ["stage 1, confine sessions: " + (off ? "off (LOADGUARD_CONFINE=0)" : works ? "on" : "cannot work here"), out];
}

function stage23(rep: Doc): Section {
  if (!rep.throttle) return ["stage 2/3, refuse heavy commands: off (LOADGUARD_THROTTLE=0)", []];
  const lim = rep.limits;
  return ["stage 2/3, refuse heavy commands: on", [["ok",
    `limits memory PSI full ${d(lim.psi_full)}%, swap ${d(lim.swap_used)}% used, ${d(lim.slots)} heavy slots`, null]]];
}

/** The learned list as the hook reads it and this session's watcher (k15). */
function learning(c: Ctx, rep: Doc): Section {
  const lrn = rep.learn;
  if (!lrn.on)
    return ["learning, heavy by what ran: off (LOADGUARD_LEARN=0)", [["--", "no watcher, the list is ignored", null]]];
  const out: Check[] = [];
  const where = lrn.file;
  if (where === null) {
    out.push(["FAIL", "no list: neither $XDG_STATE_HOME nor $HOME is an absolute path", null]);
  } else if (lrn.state === "ok") {
    out.push(["ok", `${d(lrn.entries)} learned command${plural(lrn.entries)} in ${where}`, null]);
  } else if (lrn.state === "none") {
    out.push(["ok", `no learned commands yet (${where})`, null]);
  } else {
    out.push(["FAIL", `${where} is ${lrn.state === "too-large" ? "too large" : "unreadable"}: the hook ignores it`,
      "loadguard forget all"]);
  }
  const total = asOSError(() => memTotal(c.root), null);
  out.push(["ok", `a command is learned at ${d(lrn.rss_limit)}% of MemTotal` +
    (total ? ` (${size(Number(total * BigInt(lrn.rss_limit) / 100n))})` : ""), null]);
  const scope = scopeOf(session(c.root, c.start)[1]);
  if (scope === null) {
    out.push(["--", "no watcher: this session is not confined", null]);
  } else {
    const found = learn.watcher(c.environ, scope, c.root);
    out.push(found ? ["ok", `watcher of this session: pid ${found}`, null]
      : ["FAIL", "no watcher for this session", "it starts with the session; start a new session"]);
  }
  return ["learning, heavy by what ran: on", out];
}

/** The Bun the CLI runs on and the getty-bun slot the hooks run from. */
function runtime(c: Ctx): Section {
  const out: Check[] = [];
  const running = process.versions.bun ?? "none";
  out.push(running === PIN ? ["ok", `this runs on Bun ${running}, the pin, at ${process.execPath}`, null]
    : ["FAIL", `this runs on Bun ${running}, the pin is ${PIN} (${process.execPath})`,
      `the getty-bun starter runs Bun ${PIN}`]);
  const slot = findSlot(c.environ, c.root);
  let state: string;
  if ("error" in slot) {
    state = "cannot work here";
    out.push(["FAIL", "no getty-bun slot: " + slot.error, "the starter fails the same way"]);
  } else {
    state = slot.state;
    if (slot.state === "ready") out.push(["ok", `getty-bun slot ${slot.slot} ready`, null]);
    else if (slot.state === "missing")
      out.push(["--", `no getty-bun slot yet at ${slot.slot}`, "the first hook installs Bun there (one download)"]);
    else
      out.push(["FAIL", `getty-bun slot ${slot.slot} does not match the pin ${PIN} ${slot.target}`,
        "remove that directory; the next hook installs it again"]);
  }
  return [`runtime, Bun ${PIN} from getty-bun: ${state}`, out];
}

export function doctorSections(c: Ctx): Section[] {
  const rep = doc(reportStatus(c.root));
  const sections = [stage1(c), stage23(rep), learning(c, rep), runtime(c)];
  const names = [...rep.ignored, ...confineIgnored(c.environ)];
  if (names.length > 0)
    sections.push(["environment", ignoredLines(names, c.environ).map((line): Check => ["FAIL", line, null])]);
  return sections;
}

function doctor(c: Ctx): Result {
  const lines = ["loadguard doctor"];
  let fails = 0;
  for (const [title, checks] of doctorSections(c)) {
    lines.push(title);
    for (const [state, text, hint] of checks) {
      if (state === "FAIL") fails++;
      lines.push(`  ${state.padEnd(4)}  ${text}`);
      if (hint !== null) lines.push("        -> " + hint);
    }
  }
  lines.push(fails === 0 ? "all good" : `${fails} problem${plural(fails)}`);
  return { rc: fails ? 1 : 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

// --- usage, main ----------------------------------------------------------------------------------

export const USAGE = `usage: loadguard status | doctor | explain '<command>' | learned
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

function usage(rc: number): Result {
  return rc === 0 ? { rc, stdout: USAGE + "\n", stderr: "" } : { rc, stdout: "", stderr: USAGE + "\n" };
}

/** The command on stdin: its bytes, one final newline dropped. */
function fromStdin(raw: Uint8Array): Bytes {
  const s = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1");
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/**
 * The CLI: args without the program, stdin read only for `explain` without
 * a command. Every figure comes from the environment and the host as the
 * hook would see them from this process.
 */
export async function main(args: string[], stdin: () => Promise<Uint8Array>, where: Where = {}): Promise<Result> {
  const c: Ctx = {
    root: where.root ?? "", uid: where.uid ?? process.getuid?.() ?? -1, me: where.me ?? process.pid,
    start: where.start ?? process.ppid, self: where.self ?? import.meta.path, environ: process.env,
  };
  const [cmd, ...rest] = args;
  if (cmd === "help") return usage(0);
  if (cmd === "status" && rest.length === 0) return status(c);
  if (cmd === "doctor" && rest.length === 0) return doctor(c);
  if (cmd === "explain" && rest.length === 0) {
    const command = fromStdin(await stdin());
    return command === "" ? usage(2) : explain(c, command);
  }
  if (cmd === "explain" && !(rest[0] as string).startsWith("-")) return explain(c, utf8Bytes(rest.join(" ")));
  if (cmd === "learned" && rest.length === 0) return learned(c.environ);
  if (cmd === "forget" && rest.length > 0) return forget(c.environ, rest);
  return usage(2);
}
