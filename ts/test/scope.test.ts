// ts/scope.ts, the port of lib/loadguard/confine.py: the busctl argv, the
// names, and one real transient scope around `sleep` with tiny limits
// (t/test_confine.py RealScope). The full fake-host suite runs against this
// code through t/test_parity.py. Real systemd only as --user scopes named
// loadguard-test-*, removed again; skipped without busctl, a user bus or
// memory delegation. Nothing here allocates memory on purpose.
import { describe, expect, test } from "bun:test";
import { attach, busctlArgv, cgroup, inLoadguardScope, scopeName, startScope, waitAttached } from "../scope.js";
import { gone, realScopeBusctl, systemctl } from "./helpers.js";

const SESSION = "091fbf8e-fba9-4db6-9742-c3a092c6da8a";
const SLICE_PATH = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-loadguard.slice";

describe("busctl", () => {
  test("the exact StartTransientUnit call", () => {
    expect(busctlArgv("/usr/bin/busctl", "loadguard-091fbf8e-42.scope", [42, 43],
      [["MemoryHigh", 1n], ["MemoryMax", 2n], ["MemorySwapMax", 0n], ["CPUWeight", 50n]],
      "loadguard: claude session s")).toEqual([
      "/usr/bin/busctl", "--user", "--timeout=2", "call",
      "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager", "StartTransientUnit",
      "ssa(sv)a(sa(sv))", "loadguard-091fbf8e-42.scope", "fail", "10",
      "Description", "s", "loadguard: claude session s",
      "Slice", "s", "app-loadguard.slice",
      "PIDs", "au", "2", "42", "43",
      "MemoryHigh", "t", "1", "MemoryMax", "t", "2",
      "MemorySwapMax", "t", "0", "CPUWeight", "t", "50",
      "OOMPolicy", "s", "continue",
      "CollectMode", "s", "inactive-or-failed",
      "Delegate", "b", "true",
      "0"]);
  });

  test("scope names", () => {
    expect(scopeName(SESSION, 42)).toBe("loadguard-091fbf8e-42.scope");
    expect(scopeName("a/b.c-d_e;f g", 7)).toBe("loadguard-abcdefg-7.scope");
    expect(scopeName(null, 7)).toBe("loadguard-7.scope");
    expect(scopeName("", 7)).toBe("loadguard-7.scope");
  });

  test("in a loadguard scope", () => {
    expect(inLoadguardScope(SLICE_PATH + "/loadguard-091fbf8e-42.scope")).toBe(true);
    expect(inLoadguardScope(SLICE_PATH + "/loadguard-7.scope/sub")).toBe(true);
    for (const path of ["/user.slice/user-1000.slice/session-2.scope", SLICE_PATH, "/", "",
      "/user.slice/x/run-p1-i2.scope", "/user.slice/x/notloadguard-1.scope"])
      expect(inLoadguardScope(path)).toBe(false);
  });
});

const BUSCTL = realScopeBusctl();

describe("a real scope", () => {
  test.skipIf(BUSCTL === null)("limits, a late process, cleanup (needs busctl, a user bus, memory delegation)", async () => {
    const busctl = BUSCTL as string;
    const sleeper = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const late = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const name = `loadguard-test-${sleeper.pid}.scope`;
    try {
      expect(startScope(busctl, name, [sleeper.pid],
        [["MemoryHigh", 16n << 20n], ["MemoryMax", 32n << 20n], ["MemorySwapMax", 0n], ["CPUWeight", 10n]],
        "loadguard: unit test")).toBe(true);
      expect(waitAttached("", sleeper.pid, name)).toBe(true);
      // A process started before the scope joins it later (k12).
      expect(attach(busctl, name, [late.pid])).toBe(true);
      expect(cgroup("", late.pid)?.endsWith("/" + name)).toBe(true);
      expect(cgroup("", sleeper.pid)?.endsWith("/app-loadguard.slice/" + name)).toBe(true);
      const shown = systemctl("show", name, "-p", "MemoryHigh", "-p", "MemoryMax", "-p", "MemorySwapMax",
        "-p", "CPUWeight", "-p", "OOMPolicy", "-p", "Delegate").split("\n");
      for (const line of ["MemoryHigh=16777216", "MemoryMax=33554432", "MemorySwapMax=0", "CPUWeight=10",
        "OOMPolicy=continue", "Delegate=yes"])
        expect(shown).toContain(line);
    } finally {
      sleeper.kill(9);
      late.kill(9);
      await sleeper.exited;
      await late.exited;
    }
    await gone(name);
  });
});
