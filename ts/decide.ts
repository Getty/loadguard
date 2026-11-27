// The decision, ported from src/loadguard-hook.c: limits (env_int, limit,
// throttle_off, default_slots), the reason and context texts
// (pressure_figures, measures, advice, situation), under_pressure, no_room,
// objection, from_codex, context_event, respond and hook.
import { availableParallelism } from "node:os";
import { type Bytes, fixed, isDigit } from "./bytes.js";
import { heavyCommand, Kind, type Match } from "./classify.js";
import { get, jobj, jstr, type JValue, print, str } from "./cjson.js";
import { getenv } from "./env.js";
import { lessonFor, lessonLabel } from "./learned.js";
import { type Pressure, readPressure, zramFill } from "./measure.js";
import { bashCommand } from "./payload.js";
import { scanSlots, type Slots } from "./slots.js";

/** Defaults, calibrated on ~/load-incidents (docs/design.md, k4). */
const PSI_FULL_DEFAULT = 10;  // % memory full avg10: calm <= 2.03, thrash >= 45.47
const SWAP_USED_DEFAULT = 90; // % of all swap: calm <= 68.3, thrash >= 91.9
export const LEARN_RSS_DEFAULT = 20; // % of MemTotal

/** The tunable limits; the reports list the ones set but invalid. */
export const LIMITS = {
  psiFull: { env: "LOADGUARD_PSI_FULL", lo: 1, hi: 100 },
  swapUsed: { env: "LOADGUARD_SWAP_USED", lo: 1, hi: 100 },
  slots: { env: "LOADGUARD_HEAVY_SLOTS", lo: 1, hi: 4096 },
  learnRss: { env: "LOADGUARD_LEARN_RSS", lo: 1, hi: 100 },
} as const;

/** An integer from the environment (a trailing % allowed), else def. */
function envInt(name: string, def: number, lo: number, hi: number): number {
  const s = getenv(name);
  if (s === null || !isDigit(s[0])) return def;
  let v = 0, i = 0;
  for (; isDigit(s[i]); i++)
    if ((v = v * 10 + (s.charCodeAt(i) - 0x30)) > hi) return def;
  if (s[i] === "%") i++;
  return i === s.length && v >= lo ? v : def;
}

export function limit(which: keyof typeof LIMITS, def: number): number {
  const l = LIMITS[which];
  return envInt(l.env, def, l.lo, l.hi);
}

/** LOADGUARD_THROTTLE=0, only that exact value: pure pass-through. */
export function throttleOff(): boolean {
  return getenv("LOADGUARD_THROTTLE") === "0";
}

/** max(1, nproc / 2), nproc as `nproc` counts: the CPUs we may run on. */
export function defaultSlots(): number {
  const n = availableParallelism();
  return n >= 2 ? Math.floor(n / 2) : 1;
}

/** add(): s appended to a text of size bytes at most, as vsnprintf cuts it. */
class Text {
  t = "";
  constructor(readonly size: number) {}
  add(s: Bytes): void {
    if (this.t.length + 1 >= this.size) return;
    this.t = (this.t + s).slice(0, this.size - 1);
  }
}

export interface Config {
  psiFull: number;
  swapUsed: number;
  slots: number;
}

/** "memory pressure full=59.9% (limit 10%), swap 100% used (limit 90%)" */
function pressureFigures(r: Text, pr: Pressure, c: Config): void {
  if (pr.full >= 0) r.add("memory pressure full=" + fixed(pr.full, 1) + "% (limit " + c.psiFull + "%)");
  else r.add("memory pressure n/a");
  if (pr.swap >= 0) r.add(", swap " + pr.swap + "% used (limit " + c.swapUsed + "%)");
}

function measures(r: Text, root: Bytes, pr: Pressure, c: Config): void {
  const zram = zramFill(root);
  pressureFigures(r, pr, c);
  if (zram >= 0) r.add(", zram " + zram + "% full");
  r.add(".\n");
}

/**
 * Under memory pressure no test run is advised, not even a small one; with
 * full slots, a smaller run is advice for the retry.
 */
function advice(r: Text, m: Match, slots: boolean): void {
  r.add((slots ? "Wait for one to finish, then retry" : "Wait and retry later") +
    "; light commands (git status, ls, cat) still run.");
  switch (m.kind) {
    case Kind.PROVE:
      if (slots) r.add(" When you retry, run fewer tests: `prove -l t/foo.t` instead of `-r`.");
      break;
    case Kind.SUITE:
      if (slots) r.add(" When you retry, run a single test file instead of the whole suite.");
      break;
    case Kind.AGENT:
      r.add(" Do not start new `claude -p`/`claude --bg` or `codex exec`/`codex review` sessions now; do the work in this one.");
      break;
    default:
      break;
  }
}

/** What the decision found out, as far as it got. */
export interface Verdict {
  /** LOADGUARD_THROTTLE=0: nothing looked at */
  off: boolean;
  /** null: light, only the list read */
  m: Match | null;
  /** no_room() ran: c, pr set; pr at a limit */
  pressured: boolean;
  /** no_room() found no pressure: c.slots, sl set */
  scanned: boolean;
  c: Config;
  pr: Pressure;
  sl: Slots;
}

export function newVerdict(): Verdict {
  return {
    off: false, m: null, pressured: false, scanned: false,
    c: { psiFull: 0, swapUsed: 0, slots: 0 }, pr: { full: -1, swap: -1 }, sl: { busy: 0, holders: [] },
  };
}

/** Memory under pressure: PSI full avg10 or all swap used at its limit. */
export function underPressure(root: Bytes, v: Verdict): boolean {
  v.c.psiFull = limit("psiFull", PSI_FULL_DEFAULT);
  v.c.swapUsed = limit("swapUsed", SWAP_USED_DEFAULT);
  v.pr = readPressure(root);
  v.scanned = false;
  v.pressured = v.pr.full >= v.c.psiFull || v.pr.swap >= v.c.swapUsed;
  return v.pressured;
}

/** The heavy path: memory first; only without pressure the slot scan. */
export function noRoom(root: Bytes, v: Verdict): boolean {
  if (underPressure(root, v)) return true;
  v.c.slots = limit("slots", defaultSlots());
  v.sl = scanSlots(root);
  v.scanned = true;
  return v.sl.busy >= v.c.slots;
}

/** Is the exact command in the learned list? Then heavy, labelled with its peak and date. */
function learnedCommand(command: Bytes): Match | null {
  const ls = lessonFor(command);
  return ls === null ? null : { kind: Kind.LEARNED, at: 0, label: lessonLabel(ls, 64) };
}

/**
 * Did Codex send this payload (k14)? turn_id on PreToolUse and
 * UserPromptSubmit; on SessionStart the environment: PLUGIN_ROOT ==
 * CLAUDE_PLUGIN_ROOT.
 */
export function fromCodex(payload: JValue | null, event: Bytes | null): boolean {
  if (event !== "SessionStart") return str(get(payload, "turn_id")) !== null;
  const root = getenv("PLUGIN_ROOT"), claudeRoot = getenv("CLAUDE_PLUGIN_ROOT");
  return root !== null && claudeRoot !== null && root === claudeRoot;
}

/** The longest reason is about 920 bytes, the context line 216 at most. */
const REASON_MAX = 1024;

/**
 * The deny reason for a Bash command; null if loadguard has no objection.
 * Light commands return having read the learned list only. For Codex
 * without the final period.
 */
export function objection(root: Bytes, command: Bytes, codex: boolean, v: Verdict): Bytes | null {
  v.m = null;
  v.pressured = v.scanned = false;
  v.off = throttleOff();
  if (v.off) return null;
  v.m = heavyCommand(command) ?? learnedCommand(command);
  if (v.m === null) return null;
  if (!noRoom(root, v)) return null;

  const r = new Text(REASON_MAX);
  r.add("loadguard: heavy command refused (" + v.m.label + "): ");
  if (v.scanned) {
    r.add(v.sl.busy + "/" + v.c.slots + " heavy slots busy (");
    v.sl.holders.forEach((h, i) => r.add((i ? "; " : "") + h));
    if (v.sl.busy > v.sl.holders.length) r.add("; +" + (v.sl.busy - v.sl.holders.length) + " more");
    r.add("), ");
  }
  measures(r, root, v.pr, v.c);
  advice(r, v.m, v.scanned);
  return codex && r.t.endsWith(".") ? r.t.slice(0, -1) : r.t;
}

const CONTEXT_EVENTS = ["UserPromptSubmit", "SessionStart"];

/** The hook_event_name of a payload that may get the line, else null. */
export function contextEvent(payload: JValue | null): Bytes | null {
  if (payload === null || payload.t !== "obj") return null;
  const name = str(get(payload, "hook_event_name"));
  return name !== null && CONTEXT_EVENTS.includes(name) ? name : null;
}

/** The context line; null unless memory is under pressure. */
export function situation(root: Bytes, codex: boolean, v: Verdict): Bytes | null {
  v.pressured = v.scanned = false;
  v.off = throttleOff();
  if (v.off || !underPressure(root, v)) return null;
  const line = new Text(REASON_MAX);
  line.add("loadguard: ");
  pressureFigures(line, v.pr, v.c);
  line.add(". Heavy commands refused until it eases: prove, make test, builds, new claude -p/--bg. " +
    "Light commands still run" + (codex ? "" : "; see `loadguard status`") + ".");
  return line.t;
}

/** {"hookSpecificOutput": {…}} without a newline: the form recorded working in k7. */
function respond(kv: [Bytes, Bytes][]): Bytes {
  return print(jobj([["hookSpecificOutput", jobj(kv.map(([k, x]) => [k, jstr(x)]))]]));
}

/**
 * One payload: on UserPromptSubmit/SessionStart the context line or
 * nothing; else, for Bash, the documented PreToolUse deny or nothing.
 */
export function hook(root: Bytes, payload: JValue | null): Bytes {
  const event = contextEvent(payload);
  const v = newVerdict();
  if (event !== null) {
    const line = situation(root, fromCodex(payload, event), v);
    return line === null ? "" : respond([["hookEventName", event], ["additionalContext", line]]);
  }
  const command = bashCommand(payload);
  if (command === null) return "";
  const reason = objection(root, command, fromCodex(payload, null), v);
  return reason === null ? "" : respond([
    ["hookEventName", "PreToolUse"], ["permissionDecision", "deny"], ["permissionDecisionReason", reason],
  ]);
}
