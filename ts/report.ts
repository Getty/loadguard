// Report modes for bin/loadguard (k5): what objection() and no_room() found,
// as one line of JSON. Ported from src/loadguard-hook.c (report_start,
// put_learn, put_room, report_status, report_explain); figures no decision
// uses (PSI some, zram) are read here, after the fact.
import type { Bytes } from "./bytes.js";
import { jarr, jbool, jnull, jnum, jobj, jstr, type JValue, print } from "./cjson.js";
import {
  defaultSlots, fromCodex, LEARN_RSS_DEFAULT, LIMITS, limit, newVerdict, noRoom, objection,
  throttleOff, type Verdict,
} from "./decide.js";
import { getenv } from "./env.js";
import { learnedFile, learnOff, loadLessons } from "./learned.js";
import { psiSome, zramFill } from "./measure.js";
import { bashCommand } from "./payload.js";

const REPORT_FORMAT = 1;

type Items = [Bytes, JValue][];

/** A percentage, or null where the source gave none (-1). */
function percent(v: number): JValue {
  return v >= 0 ? jnum(v) : jnull;
}

/** The common head; "ignored": variables set that change nothing. */
function reportStart(mode: Bytes, off: boolean): Items {
  const ignored: JValue[] = [];
  if (getenv("LOADGUARD_THROTTLE") !== null && !off) ignored.push(jstr("LOADGUARD_THROTTLE"));
  for (const which of Object.keys(LIMITS) as (keyof typeof LIMITS)[])
    if (getenv(LIMITS[which].env) !== null && limit(which, -1) < 0) ignored.push(jstr(LIMITS[which].env));
  if (getenv("LOADGUARD_LEARN") !== null && !learnOff()) ignored.push(jstr("LOADGUARD_LEARN"));
  return [["report", jnum(REPORT_FORMAT)], ["mode", jstr(mode)], ["throttle", jbool(!off)], ["ignored", jarr(ignored)]];
}

/** The learned list as the hook reads it (k15). */
function putLearn(out: Items): void {
  const { state, lessons } = loadLessons();
  const file = learnedFile();
  out.push(["learn", jobj([
    ["on", jbool(!learnOff())],
    ["file", file === null ? jnull : jstr(file)],
    ["state", jstr(state)],
    ["entries", jnum(lessons.length)],
    ["rss_limit", jnum(limit("learnRss", LEARN_RSS_DEFAULT))],
  ])]);
}

/** What no_room() measured: limits, pressure, and the slots if scanned. */
function putRoom(out: Items, root: Bytes, v: Verdict, slotLimit: boolean): void {
  const limits: Items = [["psi_full", jnum(v.c.psiFull)], ["swap_used", jnum(v.c.swapUsed)]];
  if (slotLimit) limits.push(["slots", jnum(v.c.slots)]);
  out.push(["limits", jobj(limits)]);
  out.push(["pressure", jobj([
    ["full", percent(v.pr.full)],
    ["some", percent(psiSome(root))],
    ["swap", percent(v.pr.swap)],
    ["zram", percent(zramFill(root))],
  ])]);
  out.push(["pressured", jbool(v.pressured)]);
  out.push(["slots", v.scanned
    ? jobj([["busy", jnum(v.sl.busy)], ["holders", jarr(v.sl.holders.map(jstr))]])
    : jnull]);
}

/** One line: the JSON and a newline (puts). */
function line(out: Items): Bytes {
  return print(jobj(out)) + "\n";
}

/** --report: the host as the heavy path sees it right now. */
export function reportStatus(root: Bytes): Bytes {
  const v = newVerdict();
  v.off = throttleOff();
  const full = noRoom(root, v);
  if (!v.scanned) v.c.slots = limit("slots", defaultSlots());
  const out = reportStart("status", v.off);
  putRoom(out, root, v, true);
  out.push(["refuse_heavy", jbool(!v.off && full)]);
  putLearn(out);
  return line(out);
}

/** --explain: the hook's answer to one payload and what it looked at. */
export function reportExplain(root: Bytes, payload: JValue | null): Bytes {
  const command = bashCommand(payload);
  let reason: Bytes | null = null;
  let out: Items;
  if (command === null) {
    out = reportStart("explain", throttleOff());
    out.push(["bash", jbool(false)]);
  } else {
    const v = newVerdict();
    reason = objection(root, command, fromCodex(payload, null), v);
    out = reportStart("explain", v.off);
    out.push(["bash", jbool(true)]);
    out.push(["heavy", v.m === null ? jnull : jstr(v.m.label)]);
    if (!v.off && v.m !== null) putRoom(out, root, v, v.scanned);
  }
  out.push(["decision", jstr(reason !== null ? "deny" : "allow")]);
  out.push(["reason", reason === null ? jnull : jstr(reason)]);
  return line(out);
}
