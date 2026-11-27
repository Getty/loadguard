// The CLI (ts/commands.ts, ts/learnlist.ts, ts/slot.ts; entry dist/cli.js).
// Parity with lib/loadguard/cli.py is t/test_parity_cli.py; these pin what
// only the TS CLI has: positional arguments, explain from stdin, the runtime
// section of doctor (the getty-bun slot, read-only), the watcher check of the
// TS watcher, Python's repr and the escaping of learned commands. Every
// GETTY_HOME, HOME and state directory is a temporary one.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, pyRepr, shown, USAGE } from "../commands.js";
import { watcher } from "../learnlist.js";
import { findSlot, PIN } from "../slot.js";
import { addProcess, CALM, cleanup, ROOT, tempDir, THRASH, tree, write } from "./helpers.js";

afterAll(cleanup);

const CLI = join(ROOT, "dist", "cli.js");
const NO_STDIN = async (): Promise<Uint8Array> => new Uint8Array();

// main() reads process.env as the hook would: set what a test needs, put it back after.
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

function env(vars: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("LOADGUARD_")) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function stdin(text: string): () => Promise<Uint8Array> {
  return async () => new TextEncoder().encode(text);
}

describe("arguments", () => {
  test("positional only: the old spellings are usage errors", async () => {
    for (const args of [[], ["-h"], ["--help"], ["forget", "--all"], ["forget", "all", "1"], ["forget", "0"],
      ["forget", "-1"], ["status", "x"], ["doctor", "x"], ["learned", "x"], ["explain", "-x"], ["explain", "--", "x"]]) {
      expect(await main(args, NO_STDIN)).toEqual({ rc: 2, stdout: "", stderr: USAGE + "\n" });
    }
    expect(await main(["help"], NO_STDIN)).toEqual({ rc: 0, stdout: USAGE + "\n", stderr: "" });
    expect(USAGE).not.toMatch(/(^|\s)--?[a-z]/);
  });

  test("explain reads the command from stdin without one", async () => {
    env({ XDG_STATE_HOME: "/nonexistent/loadguard-state" });
    const root = await tree(CALM, ["idle-sessions"]);
    const where = { root, start: 1 };
    const argv = await main(["explain", "prove", "-lr", "t/"], NO_STDIN, where);
    expect(argv.stdout.startsWith("heavy:   yes (prove)\n")).toBe(true);
    // one final newline is not part of the command
    expect(await main(["explain"], stdin("prove -lr t/\n"), where)).toEqual(argv);
    const dash = await main(["explain"], stdin("-x; make test\n"), where);
    expect(dash.stdout.startsWith("heavy:   yes (make test)\n")).toBe(true);
    expect((await main(["explain"], stdin(""), where)).rc).toBe(2);
    expect((await main(["explain"], stdin("\n"), where)).rc).toBe(2);
  });

  test("the entry: exit codes and streams", () => {
    const run = (args: string[], input = "") => {
      const p = Bun.spawnSync([process.execPath, "--no-install", "--config=/dev/null", "--no-env-file", CLI, ...args],
        { stdin: new TextEncoder().encode(input), env: { PATH: process.env["PATH"] ?? "", HOME: "/home/getty",
          XDG_STATE_HOME: "/nonexistent/loadguard-state" } });
      return { rc: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
    };
    expect(run(["--help"])).toEqual({ rc: 2, stdout: "", stderr: USAGE + "\n" });
    expect(run(["help"]).rc).toBe(0);
    const st = run(["status"]);
    expect(st.rc).toBe(0);
    expect(st.stdout).toContain(`\nhook:    decided in-process by ${CLI}, the hook's own code\n`);
    const ex = run(["explain"], "git status\n");
    expect([ex.rc, ex.stderr]).toEqual([0, ""]);
    expect(ex.stdout.startsWith("heavy:   no: no heavy pattern")).toBe(true);
  });
});

describe("status", () => {
  test("pressure refuses, figures from the report", async () => {
    env({ XDG_STATE_HOME: "/nonexistent/loadguard-state" });
    const root = await tree(THRASH, ["prove-chain"]);
    const r = await main(["status"], NO_STDIN, { root, start: 1, self: "/x/cli.js" });
    expect(r.rc).toBe(0);
    expect(r.stdout.split("\n")).toEqual([
      "memory:  PSI full 59.94% (limit 10%), some 63.49%; swap 100% used (limit 90%)",
      "slots:   not scanned: under memory pressure the hook reads no other",
      "         process (that can stall on swap); pressure alone refuses",
      "heavy:   a heavy command would be refused now (memory pressure)",
      "session: not run from a Claude Code or Codex session",
      "hook:    decided in-process by /x/cli.js, the hook's own code",
      ""]);
  });

  test("an ignored variable is shown in Python's repr", async () => {
    env({ XDG_STATE_HOME: "/nonexistent/loadguard-state", LOADGUARD_THROTTLE: "it's", LOADGUARD_PSI_FULL: "5.5" });
    const r = await main(["status"], NO_STDIN, { root: await tree(CALM), start: 1 });
    expect(r.stdout).toContain(`ignored: LOADGUARD_THROTTLE="it's" changes nothing: only 0 turns it off\n`);
    expect(r.stdout).toContain("         LOADGUARD_PSI_FULL='5.5' is not valid: the default applies\n");
  });
});

test("pyRepr is Python's repr() of a str", () => {
  // the right-hand sides printed by python3 -c 'print(repr(s))'
  const cases: [string, string][] = [
    ["5.5", "'5.5'"], ["it's", `"it's"`], [`a'"b`, `'a\\'"b'`], ["\0\t\n\r\\", "'\\x00\\t\\n\\r\\\\'"],
    ["ü", "'ü'"], ["\xa0", "'\\xa0'"], ["​", "'\\u200b'"], ["😀", "'😀'"], ["\x85", "'\\x85'"],
    ["x y", "'x y'"], ["\x7f", "'\\x7f'"],
  ];
  for (const [s, want] of cases) expect(pyRepr(s)).toBe(want);
});

test("shown: one line of ASCII", () => {
  expect(shown("cat <<'EOF' | perl\nprint 1\nEOF")).toBe("cat <<'EOF' | perl\\nprint 1\\nEOF");
  expect(shown("/tmp/ü\t\\ \x01 € 😀")).toBe("/tmp/\\xfc\\t\\\\ \\x01 \\u20ac \\U0001f600");
});

describe("learned, forget", () => {
  function list(lines: string[]): { state: string; path: string } {
    const state = join(tempDir(), "state");
    const path = join(state, "loadguard", "learned.jsonl");
    mkdirSync(join(state, "loadguard"), { recursive: true });
    writeFileSync(path, lines.map((l) => l + "\n").join(""));
    return { state, path };
  }

  test("forget all, then nothing to forget", async () => {
    const { state, path } = list(['{"command": "make bench", "peak_rss": 1}', '{"command": "a\\nb"}']);
    env({ XDG_STATE_HOME: state, HOME: "/home/getty" });
    expect((await main(["learned"], NO_STDIN)).stdout).toBe(
      `2 learned commands in ${path}; each exact text is heavy:\n` +
      "  1  0 MiB  last ?\n     make bench\n  2  ? MiB  last ?\n     a\\nb\n");
    expect(await main(["forget", "all"], NO_STDIN)).toEqual({
      rc: 0, stdout: "forgot: make bench\nforgot: a\\nb\n", stderr: "" });
    expect(existsSync(path)).toBe(false);
    expect((await main(["forget", "all"], NO_STDIN)).stdout).toBe(`nothing to forget (${path})\n`);
  });

  test("forget by number rewrites as Python's json.dumps does", async () => {
    const { state, path } = list(['{"command": "a", "peak_rss": 3651934208, "cwd": "/home/getty/x"}',
      "not json", '{"command": "b", "cwd": "/tmp/ü"}', '{"command": "c"}']);
    env({ XDG_STATE_HOME: state, HOME: "/home/getty" });
    expect((await main(["learned"], NO_STDIN)).stdout).toContain("  1  3.4 GiB  last ?  in ~/x\n");
    expect(await main(["forget", "3", "3"], NO_STDIN)).toEqual({ rc: 0, stdout: "forgot: c\n", stderr: "" });
    expect(readFileSync(path, "utf8")).toBe(
      '{"command":"a","peak_rss":3651934208,"cwd":"/home/getty/x"}\n{"command":"b","cwd":"/tmp/ü"}\n');
    const bad = await main(["forget", "1", "9"], NO_STDIN);
    expect(bad).toEqual({ rc: 1, stdout: "forget: no entry 9: the list has 2; nothing changed\n", stderr: "" });
  });

  test("an unreadable list names the C library's error", async () => {
    const { state, path } = list(['{"command": "a"}']);
    chmodSync(path, 0o000);
    env({ XDG_STATE_HOME: state });
    if (process.getuid?.() === 0) return; // root reads it anyway
    const r = await main(["learned"], NO_STDIN);
    expect(r).toEqual({ rc: 1, stdout: `${path} cannot be read: Permission denied\n`, stderr: "" });
    expect((await main(["forget", "1"], NO_STDIN)).stdout).toBe(
      "forget: the list cannot be read (Permission denied); nothing changed\n");
  });
});

describe("doctor", () => {
  test("the watcher of a scope: the C binary's argv and dist/watch.js's", async () => {
    const root = await tree(null);
    const run = tempDir();
    const scope = "loadguard-00000000-9000.scope";
    write(run, `loadguard/${scope}.watch`, "4300\n");
    const cg = "0::/x/" + scope;
    addProcess(root, { pid: 4300, ppid: 1, comm: "bun", cgroup: cg, cwd: "/",
      argv: ["/g/runtimes/bun/1.4.5/linux-x64/bin/bun", "--no-install", "--config=/dev/null", "--no-env-file",
        "/p/dist/watch.js", "4100"] });
    expect(watcher({ XDG_RUNTIME_DIR: run }, scope, root)).toBe(4300);
    addProcess(root, { pid: 4301, ppid: 1, comm: "loadguard-hook", cgroup: cg, cwd: "/",
      argv: ["/d/bin/loadguard-hook", "--watch", "4100"] });
    write(run, `loadguard/${scope}.watch`, "4301\n");
    expect(watcher({ XDG_RUNTIME_DIR: run }, scope, root)).toBe(4301);
    addProcess(root, { pid: 4302, ppid: 1, comm: "bun", cgroup: cg, cwd: "/", argv: ["bun", "/p/dist/cli.js", "status"] });
    write(run, `loadguard/${scope}.watch`, "4302\n");
    expect(watcher({ XDG_RUNTIME_DIR: run }, scope, root)).toBeNull();
  });

  test("the runtime section: this Bun against the pin, the slot read-only", async () => {
    const getty = tempDir();
    env({ GETTY_HOME: getty, HOME: "/home/getty", XDG_STATE_HOME: "/nonexistent/loadguard-state", XDG_RUNTIME_DIR: tempDir() });
    const root = await tree(CALM);
    const r = await main(["doctor"], NO_STDIN, { root, start: 1, me: 1 });
    const slot = findSlot(process.env, root); // the target from root's /proc/cpuinfo
    if ("error" in slot) throw new Error(slot.error);
    expect(r.stdout).toContain(`\nruntime, Bun ${PIN} from getty-bun: missing\n` +
      `  ok    this runs on Bun ${process.versions.bun}, the pin, at ${process.execPath}\n` +
      `  --    no getty-bun slot yet at ${getty}/runtimes/bun/${PIN}/${slot.target}\n` +
      "        -> the first hook installs Bun there (one download)\n");
    expect(r.stdout).not.toContain("compiler");
    expect(existsSync(join(getty, "runtimes"))).toBe(false); // looked, wrote nothing
  });
});

describe("the getty-bun slot", () => {
  function host(flags: string, ld = true): string {
    const root = tempDir();
    write(root, "proc/cpuinfo", `processor\t: 0\nflags\t\t: fpu sse2 ${flags}\n\nprocessor\t: 1\nflags\t\t: avx2\n`);
    if (ld) write(root, "lib64/ld-linux-x86-64.so.2", "");
    return root;
  }

  function slotAt(getty: string, target: string): string {
    const slot = `${getty}/runtimes/bun/${PIN}/${target}`;
    mkdirSync(join(slot, "bin"), { recursive: true });
    return slot;
  }

  test("the target: AVX2 on the first CPU, else baseline; musl and others unsupported", () => {
    const g = { GETTY_HOME: "/g" };
    expect(findSlot(g, host("avx avx2 bmi2"), "linux", "x64")).toMatchObject({ target: "linux-x64" });
    expect(findSlot(g, host("avx"), "linux", "x64")).toMatchObject({ target: "linux-x64-baseline" });
    expect(findSlot(g, host("avx2x"), "linux", "x64")).toMatchObject({ target: "linux-x64-baseline" });
    const musl = host("avx2", false);
    write(musl, "lib/ld-musl-x86_64.so.1", "");
    expect(findSlot(g, musl, "linux", "x64")).toEqual({
      error: "unsupported target linux-x64-musl (musl libc /lib/ld-musl-x86_64.so.1, no glibc /lib64/ld-linux-x86-64.so.2)" });
    expect(findSlot(g, host("avx2"), "darwin", "arm64")).toEqual({ error: "unsupported target darwin-aarch64" });
    expect(findSlot(g, host("avx2"), "linux", "ia32")).toEqual({ error: "unsupported target linux-ia32" });
  });

  test("the store: GETTY_HOME, else ~/.getty; never a relative one", () => {
    const root = host("avx2");
    expect(findSlot({ GETTY_HOME: "/g///" }, root, "linux", "x64")).toMatchObject({ slot: `/g/runtimes/bun/${PIN}/linux-x64` });
    expect(findSlot({ GETTY_HOME: "/" }, root, "linux", "x64")).toMatchObject({ slot: `/runtimes/bun/${PIN}/linux-x64` });
    expect(findSlot({ HOME: "/h" }, root, "linux", "x64")).toMatchObject({ slot: `/h/.getty/runtimes/bun/${PIN}/linux-x64` });
    expect(findSlot({ GETTY_HOME: "", HOME: "/h" }, root, "linux", "x64")).toEqual({
      error: "GETTY_HOME must be an absolute path, got ''" });
    expect(findSlot({ HOME: "h" }, root, "linux", "x64")).toEqual({
      error: "HOME is not an absolute path; set GETTY_HOME to an absolute path" });
  });

  test("the state: ready, missing, mismatch", () => {
    const root = host("avx2"), getty = tempDir();
    const at = () => findSlot({ GETTY_HOME: getty }, root, "linux", "x64");
    expect(at()).toMatchObject({ state: "missing" });
    const slot = slotAt(getty, "linux-x64");
    expect(at()).toMatchObject({ state: "mismatch" });
    write(slot, "receipt.json", `{\n  "version": "${PIN}",\n  "target": "linux-x64",\n  "x": 1\n}\n`);
    write(slot, "bin/bun", "#!/bin/sh\n");
    expect(at()).toMatchObject({ state: "mismatch" }); // not executable
    chmodSync(join(slot, "bin/bun"), 0o755);
    expect(at()).toEqual({ slot, target: "linux-x64", state: "ready" });
    write(slot, "receipt.json", `{\n  "version": "0.0.1",\n  "target": "linux-x64",\n}\n`);
    expect(at()).toMatchObject({ state: "mismatch" });
    write(slot, "receipt.json", `{\n  "version": "${PIN}",\n  "target": "linux-x64",\n}\n`);
    write(slot, "bin/bun", "");
    expect(at()).toMatchObject({ state: "mismatch" }); // empty
  });
});
