// The watcher: its locks (bun:ffi and the flock(1) fallback, against each
// other and against the C watcher's and Python's flock), one fixture pass
// through the driver, and dist/watch.js on a real scope around a `sleep`
// called claude (t/test_learn.py RealWatcher): one per scope, gone within a
// tick of the session, the scope with it, never spinning. No load: nothing
// gets near the limit. The fixture suite runs against the C watcher through
// t/test_parity.py.
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { attach, startScope, waitAttached } from "../scope.js";
import { forceLockImpl, lockFile } from "../lock.js";
import { addProcess, baseEnv, driver, gone, realScopeBusctl, ROOT, tempDir, write } from "./helpers.js";

const WATCH_JS = join(ROOT, "dist", "watch.js");
const GIB = 1n << 30n;

afterEach(() => forceLockImpl(null));

describe("locks", () => {
  for (const [first, second] of [["ffi", "flock1"], ["flock1", "ffi"], ["ffi", "ffi"], ["flock1", "flock1"]] as const) {
    test(`${first} holds, ${second} is refused, then gets it`, () => {
      const path = join(tempDir(), "x.watch");
      const a = openSync(path, "a"), b = openSync(path, "a");
      try {
        forceLockImpl(first);
        expect(lockFile(a, true)).toBe(true);
        forceLockImpl(second);
        expect(lockFile(b, true)).toBe(false);
        closeSync(a);
        expect(lockFile(b, true)).toBe(true);
      } finally {
        try { closeSync(a); } catch { /* closed */ }
        closeSync(b);
      }
    });
  }

  test("flock(1)'s lock outlives flock(1) and excludes flock(1)", () => {
    const path = join(tempDir(), "learned.lock");
    const fd = openSync(path, "a");
    try {
      forceLockImpl("flock1");
      expect(lockFile(fd, true)).toBe(true);
      const r = Bun.spawnSync(["flock", "-x", "-n", path, "true"]);
      expect(r.exitCode).toBe(1);
    } finally {
      closeSync(fd);
    }
    expect(Bun.spawnSync(["flock", "-x", "-n", path, "true"]).exitCode).toBe(0);
  });
});

describe("one pass", () => {
  test("a call over the limit is learned with its cwd", () => {
    const dir = tempDir(), root = join(dir, "pass1");
    const scope = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-loadguard.slice/loadguard-1f0e2d3c-4100.scope";
    const page = 4096n, wrap = "source /x && eval 'perl t/big.t' < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd";
    write(root, "proc/meminfo", "MemTotal:        8025928 kB\n");
    const procs: [number, number, string, string[], bigint][] = [
      [4100, 4000, "claude", ["/home/getty/.local/bin/claude"], 300n << 20n],
      [4300, 4100, "bash", ["/bin/bash", "-c", wrap], 4n << 20n],
      [4301, 4300, "perl", ["/usr/bin/perl", "t/big.t"], 3n * GIB],
    ];
    for (const [pid, ppid, comm, argv, rss] of procs) {
      addProcess(root, { pid, ppid, comm, argv, cgroup: "0::" + scope, cwd: "/home/getty/dev/p" });
      write(root, `proc/${pid}/stat`,
        `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${pid === 4100 ? 50 : 100} 0 0\n`);
      write(root, `proc/${pid}/statm`, `${(rss / page) * 2n} ${rss / page} 100 10 0 50 0\n`);
    }
    write(root, `sys/fs/cgroup${scope}/cgroup.procs`, "4100\n4300\n4301\n");
    mkdirSync(join(dir, "run"));
    const env = baseEnv({ XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: join(dir, "run") });
    const r = driver(["watch", "4100", root], undefined, env);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { tick: 1, event: "learn", pid: 4300, peak: Number(3n * GIB + (4n << 20n)), command: "perl t/big.t" },
      { watch: "done" },
    ]);
    expect(readFileSync(join(dir, "state", "loadguard", "learned.jsonl"), "utf8")).toBe(
      `{"command":"perl t/big.t","peak_rss":${3n * GIB + (4n << 20n)},"cwd":"/home/getty/dev/p",` +
      `"first_seen":"2026-09-21T14:13:20Z","last_seen":"2026-09-21T14:13:20Z"}\n`);
  });
});

const BUSCTL = realScopeBusctl();

function niceOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
}

describe("dist/watch.js on a real scope", () => {
  test.skipIf(BUSCTL === null)("watches until the session is gone (needs busctl, a user bus, memory delegation)", async () => {
    const busctl = BUSCTL as string, tmp = tempDir();
    const fake = join(tmp, "claude");
    symlinkSync(Bun.which("sleep") as string, fake);
    const claude = Bun.spawn([fake, "60"], { stdio: ["ignore", "ignore", "ignore"] });
    const name = `loadguard-test-${claude.pid}.scope`;
    let watcher: ReturnType<typeof Bun.spawn> | null = null;
    try {
      expect(startScope(busctl, name, [claude.pid], [["MemoryMax", 64n << 20n]], "loadguard: unit test")).toBe(true);
      expect(waitAttached("", claude.pid, name)).toBe(true);
      const env = baseEnv({ XDG_RUNTIME_DIR: join(tmp, "run"), XDG_STATE_HOME: join(tmp, "state") });
      const argv = [process.execPath, "--no-install", "--config=/dev/null", "--no-env-file", WATCH_JS, String(claude.pid)];
      watcher = Bun.spawn(argv, { env, stdio: ["ignore", "ignore", "ignore"], detached: true });
      expect(attach(busctl, name, [watcher.pid])).toBe(true);
      const lock = join(tmp, "run", "loadguard", name + ".watch");
      const held = () => (existsSync(lock) ? readFileSync(lock, "utf8") : "");
      const deadline = performance.now() + 5000;
      while (held() === "") {
        expect(performance.now()).toBeLessThan(deadline);
        await Bun.sleep(50);
      }
      expect(held()).toBe(`${watcher.pid}\n`);
      expect(niceOf(watcher.pid)).toBe(10);
      // A second watcher for the scope ends at once.
      const start = performance.now();
      const second = Bun.spawnSync(argv, { env, stdin: "ignore" });
      expect([second.exitCode, second.stdout.toString(), second.stderr.toString()]).toEqual([0, "", ""]);
      expect(performance.now() - start).toBeLessThan(1500);
      claude.kill(9);
      await claude.exited;
      // Within a tick (2 s) the watcher is gone, and the scope with it.
      const code = await Promise.race([watcher.exited, Bun.sleep(6000).then(() => "lingers")]);
      expect(code).toBe(0);
      // Never spinning: Bun's start plus a few reads per 2 s (~20 ms here),
      // held to the C watcher's bound.
      const cpu = watcher.resourceUsage()?.cpuTime.total ?? Infinity;
      expect(Number(cpu)).toBeLessThan(200_000); // µs
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(join(tmp, "state"))).toBe(false);
    } finally {
      if (watcher !== null && watcher.exitCode === null) watcher.kill(9);
      claude.kill(9);
      await claude.exited;
    }
    await gone(name);
  });
});
