// The decision through the bundled driver against the fixture trees of
// t/fixtures/: measurement, slot scan, deny reasons, the context line, the
// Codex spellings, the report modes and the learned list. The cases of
// t/test_throttle.py and t/test_learn.py that carry the design; the Python
// suite keeps the rest and the C oracle until the switch (B7).
import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  baseEnv, CALM, driver, encoder, fixtureJson, json, payload, reason, tempDir, THRASH, tree, write,
} from "./helpers.js";

const WAIT = "\nWait and retry later; light commands (git status, ls, cat) still run.";
const ADVICE = ". Heavy commands refused until it eases: prove, make test, builds, new claude -p/--bg. " +
  "Light commands still run; see `loadguard status`.";
const THRASH_LINE = "loadguard: memory pressure full=59.9% (limit 10%), swap 100% used (limit 90%)" + ADVICE;

function setPsiFull(root: string, avg10: number): void {
  const v = avg10.toFixed(2);
  write(root, "proc/pressure/memory",
    `some avg10=${v} avg60=0.00 avg300=0.00 total=1\nfull avg10=${v} avg60=0.00 avg300=0.00 total=1\n`);
}

function setSwapUsed(root: string, percent: number): void {
  const total = 11598972, used = Math.ceil(total * percent / 100);
  write(root, "proc/meminfo",
    `MemTotal:        8025928 kB\nSwapTotal:      ${total} kB\nSwapFree:       ${total - used} kB\n`);
}

function mkfifo(path: string): void {
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
}

function fifo(root: string, rel: string): void {
  unlinkSync(join(root, rel));
  mkfifo(join(root, rel));
}

function line(root: string, event: string, env: Record<string, string> = {}, extra = {}): string {
  const r = driver(["decide", root], json({ hook_event_name: event, session_id: "s", ...extra }), baseEnv(env));
  expect([r.rc, r.stderr]).toEqual([0, ""]);
  if (r.stdout === "") return "";
  const doc = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> };
  expect(Object.keys(doc)).toEqual(["hookSpecificOutput"]);
  expect(Object.keys(doc.hookSpecificOutput)).toEqual(["hookEventName", "additionalContext"]);
  return doc.hookSpecificOutput["additionalContext"] ?? "";
}

describe("measure", () => {
  test("recorded calm, reconstructed thrash, nothing", async () => {
    expect(driver(["measure", CALM]).stdout).toBe("full=0.00 swap=60 zram=97");
    expect(driver(["measure", THRASH]).stdout).toBe("full=59.94 swap=100 zram=-1");
    expect(driver(["measure", await tree(null)]).stdout).toBe("full=-1.00 swap=-1 zram=-1");
    expect(driver(["measure", "/nonexistent/loadguard-root"]).stdout).toBe("full=-1.00 swap=-1 zram=-1");
  });
});

describe("slots", () => {
  const slots = (root: string, env = {}) => driver(["slots", root], encoder.encode("{}"), baseEnv(env)).stdout;

  test("one running command is one slot; agents and sandbox helpers hold none", async () => {
    expect(slots(await tree(CALM, ["idle-sessions"]))).toBe("0\n");
    expect(slots(await tree(CALM, ["idle-sessions", "prove-chain"]))).toBe("1\nprove -lr t/ in ~/dev/sunriser\n");
    expect(slots(await tree(CALM, ["idle-sessions", "make-recursion"]))).toBe("1\nmake test in ~/dev/p5-foo\n");
    expect(slots(await tree(CALM, ["idle-sessions", "claude-p"]))).toBe("0\n");
    expect(slots(await tree(CALM, ["idle-sessions", "npm-title"]))).toBe("1\nnpm test in ~/dev/p5-foo\n");
    expect(slots(await tree(CALM, ["idle-sessions", "codex-exec"]))).toBe("0\n");
    expect(slots(await tree(CALM, ["idle-sessions", "codex-session"]))).toBe("1\nprove -lr t/ in ~/dev/simpici\n");
  });
});

describe("decide", () => {
  test("light commands are never refused, even under thrash with full slots", async () => {
    const root = await tree(THRASH, ["idle-sessions", "prove-chain", "make-recursion"]);
    for (const command of ["git status", "ls", "cat prove.txt", "karr show 4", "perl -e 'print 1'"])
      expect(reason(root, command, { LOADGUARD_HEAVY_SLOTS: "1" })).toBe("");
  });

  test("heavy commands run when calm", async () => {
    const root = await tree(CALM, ["idle-sessions"]);
    for (const command of ["prove -lr t/", "make test", "claude -p go", "codex exec go"])
      expect(reason(root, command)).toBe("");
  });

  test("under thrash: refused, wait, no test run advised", async () => {
    expect(reason(await tree(THRASH), "cd ~/dev/x && prove -lr t/")).toBe(
      "loadguard: heavy command refused (prove): memory pressure full=59.9% (limit 10%), swap 100% used (limit 90%)." + WAIT);
  });

  test("full slots: the holders, a smaller run for the retry", async () => {
    const root = await tree(CALM, ["idle-sessions", "prove-chain", "make-recursion"]);
    expect(reason(root, "dzil test", { LOADGUARD_HEAVY_SLOTS: "2" })).toBe(
      "loadguard: heavy command refused (dzil test): 2/2 heavy slots busy (prove -lr t/ in ~/dev/sunriser; " +
      "make test in ~/dev/p5-foo), memory pressure full=0.0% (limit 10%), swap 60% used (limit 90%), zram 97% full.\n" +
      "Wait for one to finish, then retry; light commands (git status, ls, cat) still run. " +
      "When you retry, run a single test file instead of the whole suite.");
    expect(reason(root, "dzil test", { LOADGUARD_HEAVY_SLOTS: "3" })).toBe("");
    const all = await tree(CALM, ["idle-sessions", "prove-chain", "make-recursion", "claude-p", "claude-p-prove", "npm-title"]);
    expect(reason(all, "cpanm Foo", { LOADGUARD_HEAVY_SLOTS: "4" })).toContain("make test in ~/dev/p5-foo; +1 more)");
  });

  test("new agent sessions are refused with their own advice", async () => {
    const r = reason(await tree(THRASH), "codex review --uncommitted");
    expect(r).toContain("refused (codex review): ");
    expect(r.endsWith(" Do not start new `claude -p`/`claude --bg` or `codex exec`/`codex review` sessions now; " +
      "do the work in this one.")).toBe(true);
  });

  test("limits from the environment; invalid values keep the defaults; the kill switch", async () => {
    const root = await tree(CALM);
    setPsiFull(root, 15);
    expect(reason(root, "prove")).toContain("full=15.0% (limit 10%)");
    expect(reason(root, "prove", { LOADGUARD_PSI_FULL: "20%" })).toBe("");
    for (const value of ["", "abc", "0", "101", "-5", "10.5", " 20", "20%%", "99999999999999999999"])
      expect(reason(root, "prove", { LOADGUARD_PSI_FULL: value })).toContain("(limit 10%)");
    expect(reason(root, "prove", { LOADGUARD_THROTTLE: "0" })).toBe("");
    for (const value of ["", "00", "off", " 0"]) expect(reason(root, "prove", { LOADGUARD_THROTTLE: value })).not.toBe("");
  });

  test("fail open: no measurements, garbage, unreadable", async () => {
    expect(reason(await tree(null), "prove -lr t/")).toBe("");
    expect(reason("/nonexistent/loadguard-root", "prove -lr t/")).toBe("");
    const root = await tree(CALM);
    write(root, "proc/pressure/memory", "garbage\n");
    write(root, "proc/meminfo", "garbage\n");
    expect(reason(root, "prove -lr t/")).toBe("");
  });

  test("the light path opens no source; the pressure path reads no process", async () => {
    const calm = await tree(CALM);
    fifo(calm, "proc/pressure/memory");
    fifo(calm, "proc/meminfo");
    expect(reason(calm, "git status")).toBe("");
    const thrash = await tree(THRASH, ["idle-sessions", "prove-chain"]);
    fifo(thrash, "proc/4201/cmdline");
    expect(reason(thrash, "prove -lr t/")).toContain("refused (prove)");
  });

  test("not a Bash payload: nothing", async () => {
    const root = await tree(THRASH);
    for (const stdin of ["{}", "", "nul", '{"tool_name":"Read","tool_input":{"command":"prove"}}'])
      expect(driver(["decide", root], encoder.encode(stdin))).toMatchObject({ rc: 0, stdout: "" });
  });
});

describe("context line", () => {
  test("under pressure one line on both events; calm, nothing", async () => {
    const thrash = await tree(THRASH, ["idle-sessions", "prove-chain"]);
    fifo(thrash, "proc/4201/cmdline");
    for (const event of ["UserPromptSubmit", "SessionStart"]) {
      expect(line(thrash, event)).toBe(THRASH_LINE);
      expect(line(await tree(CALM, ["idle-sessions", "prove-chain"]), event)).toBe("");
      expect(line(thrash, event, { LOADGUARD_THROTTLE: "0" })).toBe("");
    }
  });

  test("at most 216 characters", async () => {
    const root = await tree(CALM);
    setPsiFull(root, 100);
    setSwapUsed(root, 100);
    const l = line(root, "UserPromptSubmit", { LOADGUARD_PSI_FULL: "100", LOADGUARD_SWAP_USED: "100" });
    expect(l).toContain("full=100.0% (limit 100%), swap 100% used (limit 100%)");
    expect(l.length).toBeLessThanOrEqual(216);
  });

  test("full slots alone say nothing", async () => {
    const root = await tree(CALM, ["idle-sessions", "prove-chain", "make-recursion"]);
    expect(line(root, "UserPromptSubmit", { LOADGUARD_HEAVY_SLOTS: "1" })).toBe("");
  });
});

describe("Codex (k14)", () => {
  test("deny without the final period, line without the pointer, Claude Code unchanged", async () => {
    const root = await tree(THRASH);
    const doc = await fixtureJson("codex/pre-tool-use.json");
    (doc["tool_input"] as Record<string, string>)["command"] = "prove -lr t/";
    const out = driver(["decide", root], json(doc)).stdout;
    const claude = driver(["decide", root], payload("prove -lr t/")).stdout;
    expect(claude.endsWith('."}}')).toBe(true);
    expect(out).toBe(claude.slice(0, -4) + '"}}');
    const ups = await fixtureJson("codex/user-prompt-submit.json");
    expect(JSON.parse(driver(["decide", root], json(ups)).stdout).hookSpecificOutput.additionalContext)
      .toBe(THRASH_LINE.replace("; see `loadguard status`", ""));
    const start = json(await fixtureJson("codex/session-start.json"));
    const codexEnv = baseEnv({ PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_ROOT: "/p" });
    expect(driver(["decide", root], start, codexEnv).stdout).not.toContain("loadguard status");
    expect(driver(["decide", root], start, baseEnv({ CLAUDE_PLUGIN_ROOT: "/p" })).stdout).toContain("loadguard status");
  });
});

describe("report modes", () => {
  const report = (args: string[], stdin = "{}", env = {}) => {
    const r = driver(args, encoder.encode(stdin), baseEnv(env));
    expect([r.rc, r.stderr, r.stdout.endsWith("}\n"), r.stdout.split("\n").length]).toEqual([0, "", true, 2]);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };

  test("status when calm", async () => {
    expect(report(["report", await tree(CALM, ["idle-sessions"])], "{}", { LOADGUARD_HEAVY_SLOTS: "2" })).toEqual({
      report: 1, mode: "status", throttle: true, ignored: [],
      limits: { psi_full: 10, swap_used: 90, slots: 2 },
      pressure: { full: 0, some: 0.31, swap: 60, zram: 97 },
      pressured: false, slots: { busy: 0, holders: [] }, refuse_heavy: false,
      learn: { on: true, file: "/nonexistent/loadguard-state/loadguard/learned.jsonl", state: "none", entries: 0, rss_limit: 20 },
    });
  });

  test("ignored variables", async () => {
    const doc = report(["report", await tree(CALM)], "{}", {
      LOADGUARD_THROTTLE: "off", LOADGUARD_PSI_FULL: "5.5", LOADGUARD_SWAP_USED: "", LOADGUARD_HEAVY_SLOTS: "0",
    });
    expect(doc["ignored"]).toEqual(["LOADGUARD_THROTTLE", "LOADGUARD_PSI_FULL", "LOADGUARD_SWAP_USED", "LOADGUARD_HEAVY_SLOTS"]);
  });

  test("explain is the hook", async () => {
    const root = await tree(THRASH);
    const light = report(["explain", root], new TextDecoder().decode(payload("cat prove.txt")));
    expect(light).toEqual({ report: 1, mode: "explain", throttle: true, ignored: [], bash: true, heavy: null, decision: "allow", reason: null });
    const heavy = report(["explain", root], new TextDecoder().decode(payload("make test")));
    expect([heavy["heavy"], heavy["decision"], heavy["reason"]])
      .toEqual(["make test", "deny", reason(root, "make test")]);
  });
});

describe("learned list (k15)", () => {
  const GIB = 1 << 30, MIB = 1 << 20;
  const COMMAND = "perl -Ilib t/json_data.t";

  function state(text: string): Record<string, string> {
    const dir = tempDir();
    write(dir, "loadguard/learned.jsonl", text);
    return { XDG_STATE_HOME: dir };
  }

  test("the exact text is heavy, labelled with its peak and date", async () => {
    const env = state(JSON.stringify({ command: COMMAND, peak_rss: Math.floor(3.4 * GIB) + 4 * MIB,
      last_seen: "2026-09-21T05:18:28Z" }) + "\n");
    const root = await tree(THRASH);
    expect(reason(root, COMMAND, env)).toBe(
      "loadguard: heavy command refused (learned: peaked at 3.4 GiB RSS on 2026-09-21): memory pressure " +
      "full=59.9% (limit 10%), swap 100% used (limit 90%)." + WAIT);
    expect(reason(root, COMMAND + " ", env)).toBe("");
    expect(reason(root, COMMAND, { ...env, LOADGUARD_LEARN: "0" })).toBe("");
    expect(reason(await tree(CALM, ["idle-sessions"]), COMMAND, env)).toBe("");
  });

  test("unusable lists count as empty, a FIFO does not block", async () => {
    const root = await tree(THRASH);
    for (const text of ["garbage\n", "[1]\n", '{"command": 7}\n'])
      expect(reason(root, COMMAND, state(text))).toBe("");
    const dir = tempDir();
    write(dir, "loadguard/.keep", "");
    mkfifo(join(dir, "loadguard", "learned.jsonl"));
    expect(reason(root, COMMAND, { XDG_STATE_HOME: dir })).toBe("");
    const doc = JSON.parse(driver(["report", root], encoder.encode("{}"), baseEnv({ XDG_STATE_HOME: dir })).stdout);
    expect(doc.learn.state).toBe("unreadable");
  });
});
