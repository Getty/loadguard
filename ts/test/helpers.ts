// Fixture trees and the bundled driver for the bun:test suite. The same
// fixtures the Python suite uses (t/fixtures/): recorded and reconstructed
// /proc trees, process specs, event payloads. Nothing here produces load.
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "bun:test";

export const ROOT = join(import.meta.dir, "..", "..");
export const FIXTURES = join(ROOT, "t", "fixtures");
export const CALM = join(FIXTURES, "proc", "reuben-recorded-20260926");
export const THRASH = join(FIXTURES, "proc", "thrash-20260917-175030-reconstructed");
export const HOME = "/home/getty";
export const SLICE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-loadguard.slice/loadguard-00000000-9000.scope";
const DRIVER = join(ROOT, "dist", "driver.js");
const encoder = new TextEncoder();

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "loadguard-bun-"));
  scratch.push(d);
  return d;
}

export function write(root: string, rel: string, text: string | Uint8Array): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

interface ProcSpec {
  pid: number;
  ppid: number;
  comm: string;
  argv: string[];
  cgroup: string;
  cwd: string | null;
}

/** One /proc/<pid> entry: stat, cmdline, cgroup, cwd (a symlink). */
export function addProcess(root: string, p: ProcSpec): void {
  const d = join(root, "proc", String(p.pid));
  write(root, `proc/${p.pid}/stat`,
    `${p.pid} (${p.comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0\n`);
  write(root, `proc/${p.pid}/cmdline`, p.argv.map((a) => a + "\0").join(""));
  write(root, `proc/${p.pid}/cgroup`, p.cgroup + "\n");
  if (p.cwd !== null) symlinkSync(p.cwd, join(d, "cwd"));
}

/** A temporary root: a pressure tree copied in, scenarios of t/fixtures/procs/ added. */
export async function tree(pressure: string | null, scenarios: string[] = []): Promise<string> {
  const root = join(tempDir(), "root");
  if (pressure === null) mkdirSync(join(root, "proc"), { recursive: true });
  else cpSync(pressure, root, { recursive: true, verbatimSymlinks: true });
  for (const name of scenarios) {
    const spec = await Bun.file(join(FIXTURES, "procs", name + ".json")).json() as { processes: ProcSpec[] };
    for (const p of spec.processes) addProcess(root, p);
  }
  return root;
}

export function payload(command: string, extra: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(JSON.stringify({
    session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command }, tool_use_id: "toolu_x", ...extra,
  }));
}

export async function fixtureJson(rel: string): Promise<Record<string, unknown>> {
  return await Bun.file(join(FIXTURES, rel)).json() as Record<string, unknown>;
}

export function json(doc: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(doc));
}

/** No LOADGUARD_* from the developer's shell, no learned list from ~/.local/state. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME, XDG_STATE_HOME: "/nonexistent/loadguard-state" };
  for (const k of ["PATH", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "XDG_CACHE_HOME", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export interface Run {
  rc: number | null;
  stdout: string;
  stderr: string;
}

/** The bundle as the starters run it: absolute Bun, no project config. */
export function driver(args: string[], stdin: Uint8Array = encoder.encode("{}"), env = baseEnv()): Run {
  const proc = Bun.spawnSync(
    [process.execPath, "--no-install", "--config=/dev/null", "--no-env-file", DRIVER, ...args],
    { stdin, env },
  );
  return { rc: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** The hook's answer: "" or the deny reason; anything else fails. */
export function reason(root: string, command: string, env: Record<string, string> = {}, extra = {}): string {
  const r = driver(["decide", root], payload(command, extra), baseEnv(env));
  if (r.rc !== 0 || r.stderr !== "") throw new Error(`driver failed: ${JSON.stringify(r)}`);
  if (r.stdout === "") return "";
  const doc = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
  const hso = doc.hookSpecificOutput;
  if (Object.keys(doc).length !== 1 || hso["hookEventName"] !== "PreToolUse" || hso["permissionDecision"] !== "deny")
    throw new Error(`not the deny form: ${r.stdout}`);
  return hso["permissionDecisionReason"] ?? "";
}

export { encoder };
