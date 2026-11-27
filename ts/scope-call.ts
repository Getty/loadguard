// The test driver's `scope-call`: one function of ts/scope.ts called with
// JSON arguments, for the parity harness against lib/loadguard/confine.py
// and learn.start_watcher (t/test_parity.py). Production never gets here.
import * as scope from "./scope.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function props(o: Json): [string, number][] {
  return Object.entries(o as Record<string, number>);
}

function host(o: Json): scope.Host & scope.Launch {
  const h = o as Record<string, Json>, out: scope.Host & scope.Launch = {};
  if (typeof h["root"] === "string") out.root = h["root"];
  if (typeof h["environ"] === "object" && h["environ"] !== null) out.environ = h["environ"] as scope.Environ;
  if (typeof h["uid"] === "number") out.uid = h["uid"];
  if ("user" in h) out.user = h["user"] as string | null;
  if (typeof h["start"] === "number") out.start = h["start"];
  if (typeof h["me"] === "number") out.me = h["me"];
  if (typeof h["confirmS"] === "number") out.confirmS = h["confirmS"];
  if (typeof h["entry"] === "string") out.entry = h["entry"];
  if (typeof h["execPath"] === "string") out.execPath = h["execPath"];
  return out;
}

const FNS: Record<string, (...a: Json[]) => unknown> = {
  findSession: (root, start) => scope.findSession(root as string, start as number),
  sessionName: (root, pid) => scope.sessionName(root as string, pid as number),
  descendants: (root, pid) => scope.descendants(root as string, pid as number),
  cgroup: (root, pid) => scope.cgroup(root as string, pid as number),
  limits: (root, environ) => {
    const l = scope.limits(root as string, environ as scope.Environ);
    return l === null ? null : Object.fromEntries(l.map(([k, v]) => [k, Number(v)]));
  },
  delegated: (root, runtimeDir, uid) => scope.delegated(root as string, runtimeDir as string, uid as number),
  lingering: (root, user) => scope.lingering(root as string, user as string | null),
  scopeName: (id, pid) => scope.scopeName(id as string | null, pid as number),
  inLoadguardScope: (path) => scope.inLoadguardScope(path as string),
  busctlArgv: (b, name, pids, p, d) => scope.busctlArgv(b as string, name as string, pids as number[], props(p), d as string),
  startScope: (b, name, pids, p, d) => scope.startScope(b as string, name as string, pids as number[], props(p), d as string),
  attach: (b, name, pids) => scope.attach(b as string, name as string, pids as number[]),
  waitAttached: (root, pid, name, s) => scope.waitAttached(root as string, pid as number, name as string, s as number),
  findBusctl: (environ) => scope.findBusctl(environ as scope.Environ),
  confine: (id, h) => scope.confine(id as string | null, host(h)),
  startWatcher: (status, h) => scope.startWatcher(status as string, host(h)),
};

/** {"fn": NAME, "args": [...]} -> {"value": ...} or {"raise": KIND} */
export function scopeCall(text: string): string {
  const call = JSON.parse(text) as { fn: string; args: Json[] };
  const fn = FNS[call.fn];
  if (fn === undefined) return JSON.stringify({ raise: "NoSuchFunction" }) + "\n";
  try {
    return JSON.stringify({ value: fn(...call.args) ?? null }) + "\n";
  } catch (e) {
    return JSON.stringify({ raise: e instanceof scope.PyError ? e.kind : "Error" }) + "\n";
  }
}
