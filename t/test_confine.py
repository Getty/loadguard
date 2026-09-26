"""Stage 1, session confinement: lib/loadguard/confine.py, hooks/loadguard-confine.

The logic runs against synthetic /proc and /sys trees in a temp directory
(shapes copied from reuben, 2026-09-26) and a fake busctl that records its
argv and plays systemd by rewriting the fixture's /proc/<pid>/cgroup. One
narrow test starts a real scope around a `sleep` with tiny limits; it is
skipped without busctl, a user bus or memory delegation. Nothing here
allocates memory on purpose.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
ENTRY = os.path.join(ROOT, "hooks", "loadguard-confine")

from loadguard import confine  # noqa: E402

UID = 1000
BOOT = "4a6b8362-ed02-4d0f-9a3d-c85c6bd2bb49"
SESSION = "091fbf8e-fba9-4db6-9742-c3a092c6da8a"
LOGIND = "/user.slice/user-1000.slice/session-2.scope"
MEMINFO_8G = "MemTotal:        8025420 kB\nMemFree:  1155072 kB\n"
GIB = 1 << 30

# Records argv (one line per call, NUL-separated args), then plays systemd:
# writes the scope path into the cgroup file of the first PID. FAKE_FAIL=n
# fails every call with more than n PIDs; FAKE_NOMOVE leaves cgroups alone.
FAKE_BUSCTL = r"""#!/bin/sh
printf '%s\0' "$@" >> "$FAKE_LOG"; echo >> "$FAKE_LOG"
name=$9; n=0; pid=
while [ $# -gt 0 ]; do
  if [ "$1" = PIDs ]; then n=$3; pid=$4; break; fi
  shift
done
if [ -n "$FAKE_FAIL" ] && [ "$n" -gt "$FAKE_FAIL" ]; then
  echo "Call failed: Failed to set unit properties: No such process" >&2
  exit 1
fi
[ -n "$FAKE_NOMOVE" ] || printf '0::%s/%s\n' "$FAKE_SLICE" "$name" \
  > "$FAKE_ROOT/proc/$pid/cgroup"
echo 'o "/org/freedesktop/systemd1/job/1"'
"""
SLICE_PATH = ("/user.slice/user-1000.slice/user@1000.service/app.slice/"
              "app-loadguard.slice")


class Tree:
    """A fake host: /proc, /sys, a runtime dir with a bus socket, a PATH."""

    def __init__(self, tmp):
        self.root = os.path.join(tmp, "host")
        self.runtime = os.path.join(tmp, "run")
        self.bin = os.path.join(tmp, "bin")
        self.log = os.path.join(tmp, "busctl.log")
        for d in (self.root + "/proc/sys/kernel/random", self.runtime,
                  self.bin, os.path.dirname(self.root + confine.controllers_path(UID))):
            os.makedirs(d, exist_ok=True)
        self.write("/proc/sys/kernel/random/boot_id", BOOT + "\n")
        self.write("/proc/meminfo", MEMINFO_8G)
        self.write(confine.controllers_path(UID), "cpu memory pids\n")
        self.bus = os.path.join(self.runtime, "bus")
        with open(self.bus, "w"):
            pass  # existence is all confine checks
        busctl = os.path.join(self.bin, "busctl")
        with open(busctl, "w") as f:
            f.write(FAKE_BUSCTL)
        os.chmod(busctl, 0o755)
        self.env = {"XDG_RUNTIME_DIR": self.runtime, "PATH": self.bin}
        os.environ.update(FAKE_LOG=self.log, FAKE_ROOT=self.root,
                          FAKE_SLICE=SLICE_PATH)
        for var in ("FAKE_FAIL", "FAKE_NOMOVE"):
            os.environ.pop(var, None)

    def write(self, path, text):
        os.makedirs(os.path.dirname(self.root + path), exist_ok=True)
        with open(self.root + path, "w") as f:
            f.write(text)

    def proc(self, pid, ppid, comm, cmdline=None, cgroup=LOGIND):
        self.write("/proc/%d/stat" % pid,
                   "%d (%s) S %d %d 0 0 -1 4194560 1 0 0 0\n"
                   % (pid, comm, ppid, pid))
        self.write("/proc/%d/comm" % pid, comm + "\n")
        self.write("/proc/%d/cmdline" % pid,
                   "\0".join(cmdline or [comm]) + "\0")
        self.write("/proc/%d/cgroup" % pid, "0::%s\n" % cgroup)

    def calls(self):
        try:
            with open(self.log, "rb") as f:
                lines = f.read().split(b"\0\n")
        except FileNotFoundError:
            return []
        return [[a.decode() for a in line.split(b"\0")]
                for line in lines if line]

    def confine(self, start, session_id=SESSION, env=None):
        # The hook itself is 2549601 in reuben_session(), a child of start.
        return confine.confine(session_id, start=start, root=self.root,
                               environ=self.env if env is None else env,
                               uid=UID, me=2549601)


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        self.t = Tree(tmp.name)

    def reuben_session(self):
        """sshd → screen → bash → claude → {sh → hook, 2 MCP servers}."""
        t = self.t
        t.proc(1169, 1, "sshd-session")
        t.proc(1357, 1169, "screen")
        t.proc(2528747, 1357, "bash")
        t.proc(2549533, 2528747, "claude",
               ["/home/getty/.local/bin/claude", "--model", "haiku"])
        t.proc(2549600, 2549533, "sh", ["/bin/sh", "-c", "hook"])
        t.proc(2549601, 2549600, "python3", ["python3", "loadguard-confine"])
        t.proc(2549700, 2549533, "npm exec serper")
        t.proc(2549701, 2549700, "node")
        return 2549533


class FindClaude(Base):
    def test_parent_is_claude(self):
        claude = self.reuben_session()
        self.t.proc(2549602, claude, "python3")
        self.assertEqual(confine.find_claude(self.t.root, claude),
                         (claude, []))

    def test_shell_in_between(self):
        claude = self.reuben_session()
        self.assertEqual(confine.find_claude(self.t.root, 2549600),
                         (claude, [2549600]))
        self.assertEqual(confine.find_claude(self.t.root, 2549601),
                         (claude, [2549601, 2549600]))

    def test_argv0_when_comm_differs(self):
        # comm is the thread-ish name, argv[0] the installed binary.
        self.t.proc(500, 1, "MainThread", ["/opt/bin/claude", "-p"])
        self.t.proc(501, 500, "sh")
        self.assertEqual(confine.find_claude(self.t.root, 501), (500, [501]))

    def test_not_fooled_by_lookalikes(self):
        # claude-code-history MCP server, a script mentioning claude.
        self.t.proc(600, 1, "node", ["node", "/x/.bin/claude-code-history"])
        self.t.proc(601, 600, "claude-wrapper", ["/usr/bin/claude-wrapper"])
        self.t.proc(602, 601, "sh")
        self.assertEqual(confine.find_claude(self.t.root, 602), (None, []))

    def test_comm_with_spaces_and_parens(self):
        self.t.proc(700, 1, "claude")
        self.t.proc(701, 700, "a) (b")
        self.assertEqual(confine.find_claude(self.t.root, 701), (700, [701]))

    def test_no_claude_up_to_init(self):
        self.t.proc(800, 1, "bash")
        self.t.proc(801, 800, "python3")
        self.assertEqual(confine.find_claude(self.t.root, 801), (None, []))

    def test_depth_limit(self):
        self.t.proc(900, 1, "claude")
        for pid in range(901, 901 + confine.MAX_DEPTH):
            self.t.proc(pid, pid - 1, "sh")
        self.assertEqual(confine.find_claude(self.t.root, 900 + confine.MAX_DEPTH),
                         (None, []))
        self.assertEqual(
            confine.find_claude(self.t.root, 899 + confine.MAX_DEPTH)[0], 900)

    def test_nearest_claude_wins(self):
        # claude -p started from a Bash command of another claude.
        outer = self.reuben_session()
        self.t.proc(3000, outer, "bash")
        self.t.proc(3001, 3000, "claude", ["claude", "-p", "x"])
        self.t.proc(3002, 3001, "python3")
        self.assertEqual(confine.find_claude(self.t.root, 3002), (3001, [3002]))


class Descendants(Base):
    def test_whole_subtree(self):
        claude = self.reuben_session()
        self.assertEqual(sorted(confine.descendants(self.t.root, claude)),
                         [2549600, 2549601, 2549700, 2549701])
        self.assertEqual(confine.descendants(self.t.root, 2549701), [])

    def test_unreadable_entries_skipped(self):
        claude = self.reuben_session()
        os.makedirs(self.t.root + "/proc/4242")  # vanished: no stat
        self.t.write("/proc/4243/stat", "garbage")
        self.t.write("/proc/self/stat", "not a pid dir")
        self.assertIn(2549700, confine.descendants(self.t.root, claude))


class Limits(Base):
    def test_defaults_for_reuben(self):
        total = 8025420 * 1024  # 7.65 GiB
        props = confine.limits(self.t.root, {})
        self.assertEqual(props, {"MemoryHigh": total * 30 // 100,
                                 "MemoryMax": total * 40 // 100,
                                 "MemorySwapMax": total * 10 // 100,
                                 "CPUWeight": 50})
        # The 3.8 GB perl one-liner (20260917-175030) cannot fit in one
        # session: RAM ceiling plus swap allowance stays below it once claude
        # itself (~300 MB) is counted.
        perl, claude = 3870492 * 1024, 300 << 20
        self.assertLess(props["MemoryMax"] + props["MemorySwapMax"],
                        perl + claude)
        # A normal build (well under 2 GB) is not even throttled.
        self.assertGreater(props["MemoryHigh"], 2 * GIB)

    def test_env_overrides(self):
        total = 8025420 * 1024
        props = confine.limits(self.t.root, {
            "LOADGUARD_MEMORY_HIGH": "50", "LOADGUARD_MEMORY_MAX": "60%",
            "LOADGUARD_MEMORY_SWAP_MAX": "0", "LOADGUARD_CPU_WEIGHT": "100"})
        self.assertEqual(props, {"MemoryHigh": total * 50 // 100,
                                 "MemoryMax": total * 60 // 100,
                                 "MemorySwapMax": 0, "CPUWeight": 100})

    def test_bad_env_falls_back_to_default(self):
        default = confine.limits(self.t.root, {})
        for value in ("", "abc", "-5", "0", "101", "1.5", " 40", "40 %",
                      "4O"):
            with self.subTest(value=value):
                props = confine.limits(self.t.root,
                                       {"LOADGUARD_MEMORY_MAX": value})
                self.assertEqual(props, default)
        self.assertEqual(confine.limits(
            self.t.root, {"LOADGUARD_CPU_WEIGHT": "10001"}), default)

    def test_no_memtotal(self):
        self.t.write("/proc/meminfo", "MemFree: 1 kB\n")
        self.assertIsNone(confine.limits(self.t.root, {}))
        self.t.write("/proc/meminfo", "MemTotal: 12 MB\n")
        self.assertIsNone(confine.limits(self.t.root, {}))


class Delegation(Base):
    def cache(self):
        with open(os.path.join(self.t.runtime, "loadguard", "delegation")) as f:
            return f.read()

    def test_yes_is_cached(self):
        self.assertTrue(confine.delegated(self.t.root, self.t.runtime, UID))
        self.assertEqual(self.cache(), BOOT + " yes\n")
        # Answered from the cache from now on, even if the file changes.
        self.t.write(confine.controllers_path(UID), "cpu pids\n")
        self.assertTrue(confine.delegated(self.t.root, self.t.runtime, UID))

    def test_no_is_cached(self):
        self.t.write(confine.controllers_path(UID), "cpu pids\n")
        self.assertFalse(confine.delegated(self.t.root, self.t.runtime, UID))
        self.assertEqual(self.cache(), BOOT + " no\n")

    def test_memory_must_be_a_whole_word(self):
        self.t.write(confine.controllers_path(UID), "cpu memoryx pids\n")
        self.assertFalse(confine.delegated(self.t.root, self.t.runtime, UID))

    def test_other_boot_is_recomputed(self):
        os.makedirs(os.path.join(self.t.runtime, "loadguard"))
        with open(os.path.join(self.t.runtime, "loadguard", "delegation"),
                  "w") as f:
            f.write("0000-old-boot no\n")
        self.assertTrue(confine.delegated(self.t.root, self.t.runtime, UID))
        self.assertEqual(self.cache(), BOOT + " yes\n")

    def test_garbage_cache_is_recomputed(self):
        os.makedirs(os.path.join(self.t.runtime, "loadguard"))
        with open(os.path.join(self.t.runtime, "loadguard", "delegation"),
                  "w") as f:
            f.write(BOOT + " maybe\n")
        self.assertTrue(confine.delegated(self.t.root, self.t.runtime, UID))
        self.assertEqual(self.cache(), BOOT + " yes\n")

    def test_unreadable_controllers_is_no_and_not_cached(self):
        os.remove(self.t.root + confine.controllers_path(UID))
        self.assertFalse(confine.delegated(self.t.root, self.t.runtime, UID))
        self.assertFalse(os.path.exists(
            os.path.join(self.t.runtime, "loadguard", "delegation")))

    def test_unwritable_cache_still_answers(self):
        blocker = os.path.join(self.t.runtime, "loadguard")
        with open(blocker, "w"):
            pass  # a file where the directory should be
        self.assertTrue(confine.delegated(self.t.root, self.t.runtime, UID))


class BusctlArgv(unittest.TestCase):
    def test_exact_call(self):
        argv = confine.busctl_argv(
            "/usr/bin/busctl", "loadguard-091fbf8e-42.scope", [42, 43],
            {"MemoryHigh": 1, "MemoryMax": 2, "MemorySwapMax": 0,
             "CPUWeight": 50}, "loadguard: claude session s")
        self.assertEqual(argv, [
            "/usr/bin/busctl", "--user", "--timeout=2", "call",
            "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager", "StartTransientUnit",
            "ssa(sv)a(sa(sv))", "loadguard-091fbf8e-42.scope", "fail", "9",
            "Description", "s", "loadguard: claude session s",
            "Slice", "s", "app-loadguard.slice",
            "PIDs", "au", "2", "42", "43",
            "MemoryHigh", "t", "1", "MemoryMax", "t", "2",
            "MemorySwapMax", "t", "0", "CPUWeight", "t", "50",
            "OOMPolicy", "s", "continue",
            "CollectMode", "s", "inactive-or-failed",
            "0"])

    def test_scope_name(self):
        self.assertEqual(confine.scope_name(SESSION, 42),
                         "loadguard-091fbf8e-42.scope")
        self.assertEqual(confine.scope_name("a/b.c-d_e;f g", 7),
                         "loadguard-abcdefg-7.scope")
        self.assertEqual(confine.scope_name(None, 7), "loadguard-7.scope")
        self.assertEqual(confine.scope_name("", 7), "loadguard-7.scope")

    def test_in_loadguard_scope(self):
        self.assertTrue(confine.in_loadguard_scope(
            SLICE_PATH + "/loadguard-091fbf8e-42.scope"))
        self.assertTrue(confine.in_loadguard_scope(
            SLICE_PATH + "/loadguard-7.scope/sub"))
        for path in (LOGIND, SLICE_PATH, "/", "",
                     "/user.slice/x/run-p1-i2.scope",
                     "/user.slice/x/notloadguard-1.scope"):
            with self.subTest(path=path):
                self.assertFalse(confine.in_loadguard_scope(path))


class Confine(Base):
    def test_attaches_claude_and_its_children(self):
        claude = self.reuben_session()
        self.assertEqual(self.t.confine(2549600), "attached")
        (argv,) = self.t.calls()
        name = "loadguard-091fbf8e-%d.scope" % claude
        self.assertEqual(argv[8], name)  # "$@": busctl itself not recorded
        i = argv.index("PIDs")
        # claude and the MCP server tree; not the hook's own shell chain.
        self.assertEqual(argv[i + 2:i + 6],
                         ["3", str(claude), "2549700", "2549701"])
        self.assertEqual(argv[argv.index("MemoryMax") + 2],
                         str(8025420 * 1024 * 40 // 100))
        self.assertEqual(confine.cgroup(self.t.root, claude),
                         SLICE_PATH + "/" + name)

    def test_idempotent(self):
        claude = self.reuben_session()
        self.assertEqual(self.t.confine(2549600), "attached")
        # resume / clear / compact: SessionStart fires again.
        for _ in range(3):
            self.assertEqual(self.t.confine(2549600, session_id="other"),
                             "already")
        self.assertEqual(len(self.t.calls()), 1)
        self.assertTrue(confine.in_loadguard_scope(
            confine.cgroup(self.t.root, claude)))

    def test_nested_claude_stays_in_parent_scope(self):
        outer = self.reuben_session()
        scope = SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % outer
        self.t.write("/proc/%d/cgroup" % outer, "0::%s\n" % scope)
        self.t.proc(3000, outer, "bash", cgroup=scope)
        self.t.proc(3001, 3000, "claude", ["claude", "-p", "x"], cgroup=scope)
        self.t.proc(3002, 3001, "python3", cgroup=scope)
        self.assertEqual(self.t.confine(3002, session_id="nested"), "already")
        self.assertEqual(self.t.calls(), [])
        self.assertEqual(confine.cgroup(self.t.root, 3001), scope)

    def test_retry_with_claude_alone(self):
        claude = self.reuben_session()
        os.environ["FAKE_FAIL"] = "1"  # a child vanished: calls with >1 PID fail
        self.assertEqual(self.t.confine(2549600), "attached")
        first, second = self.t.calls()
        i = second.index("PIDs")
        self.assertEqual(second[i + 2:i + 4], ["1", str(claude)])
        self.assertEqual(first[first.index("PIDs") + 2], "3")

    def test_start_failed(self):
        self.reuben_session()
        os.environ["FAKE_FAIL"] = "0"
        self.assertEqual(self.t.confine(2549600), "start-failed")
        self.assertEqual(len(self.t.calls()), 2)

    def test_start_failed_without_children_no_retry(self):
        self.t.proc(10, 1, "claude")
        self.t.proc(11, 10, "sh")
        os.environ["FAKE_FAIL"] = "0"
        self.assertEqual(self.t.confine(11), "start-failed")
        self.assertEqual(len(self.t.calls()), 1)

    def test_unconfirmed_move(self):
        self.reuben_session()
        os.environ["FAKE_NOMOVE"] = "1"
        saved, confine.CONFIRM_S = confine.CONFIRM_S, 0.05
        self.addCleanup(setattr, confine, "CONFIRM_S", saved)
        start = time.monotonic()
        self.assertEqual(self.t.confine(2549600), "unconfirmed")
        self.assertLess(time.monotonic() - start, 1)


class FailOpen(Base):
    """Every missing precondition: a status word, no busctl call."""

    def assert_skips(self, status, start=2549600, env=None):
        self.assertEqual(self.t.confine(start, env=env), status)
        self.assertEqual(self.t.calls(), [])

    def test_no_claude(self):
        self.t.proc(50, 1, "bash")
        self.t.proc(51, 50, "python3")
        self.assert_skips("no-claude", start=51)

    def test_cgroup_v1(self):
        claude = self.reuben_session()
        self.t.write("/proc/%d/cgroup" % claude,
                     "12:memory:/user.slice\n1:name=systemd:/user.slice\n")
        self.assert_skips("no-cgroup-v2")

    def test_no_runtime_dir(self):
        self.reuben_session()
        for env in ({"PATH": self.t.bin},
                    {"PATH": self.t.bin, "XDG_RUNTIME_DIR": ""},
                    {"PATH": self.t.bin, "XDG_RUNTIME_DIR": "run/user/1000"}):
            with self.subTest(env=env):
                self.assert_skips("no-bus", env=env)

    def test_no_bus_socket(self):
        self.reuben_session()
        os.remove(self.t.bus)
        self.assert_skips("no-bus")

    def test_no_busctl(self):
        self.reuben_session()
        self.assert_skips("no-busctl",
                          env=dict(self.t.env, PATH="/nonexistent"))

    def test_no_delegation(self):
        self.reuben_session()
        self.t.write(confine.controllers_path(UID), "cpu pids\n")
        self.assert_skips("no-delegation")

    def test_no_systemd_user_manager(self):
        self.reuben_session()
        os.remove(self.t.root + confine.controllers_path(UID))
        self.assert_skips("no-delegation")

    def test_no_meminfo(self):
        self.reuben_session()
        self.t.write("/proc/meminfo", "")
        self.assert_skips("no-meminfo")


class Entry(unittest.TestCase):
    """hooks/loadguard-confine: exit 0, empty stdout, whatever it gets.

    The environment is stripped of XDG_RUNTIME_DIR: when the tests run inside
    a claude session the real claude is an ancestor, and it must not be moved.
    """

    def run_entry(self, stdin, args=(), env=None):
        env = {"PATH": "/usr/bin:/bin"} if env is None else env
        return subprocess.run([ENTRY, *args], input=stdin, capture_output=True,
                              timeout=10, env=env)

    def test_silent_on_any_payload(self):
        for stdin in (b"", b"{", b"[]", b"null", b"\xff\xfe",
                      b'{"session_id": 7}',
                      b'{"session_id": "abc", "hook_event_name": "SessionStart",'
                      b' "source": "startup"}'):
            with self.subTest(stdin=stdin):
                proc = self.run_entry(stdin)
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))

    def test_status_flag(self):
        proc = self.run_entry(b'{"session_id": "abc"}', ["--status"])
        self.assertEqual(proc.returncode, 0)
        self.assertIn(proc.stdout, (b"no-claude\n", b"no-bus\n"))

    def test_broken_lib_still_exits_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "hooks"))
            os.makedirs(os.path.join(tmp, "lib", "loadguard"))
            entry = os.path.join(tmp, "hooks", "loadguard-confine")
            shutil.copy(ENTRY, entry)
            for name in ("__init__.py", "confine.py"):
                with open(os.path.join(tmp, "lib", "loadguard", name), "w") as f:
                    f.write("raise RuntimeError('boom')\n")
            proc = subprocess.run([entry], input=b"{}", capture_output=True,
                                  timeout=10, env={"PATH": "/usr/bin:/bin"})
            self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                             (0, b"", b""))

def real_scope_possible():
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    busctl = shutil.which("busctl")
    if not busctl or not runtime or \
            not os.path.exists(os.path.join(runtime, "bus")):
        return None
    try:
        with open(confine.controllers_path(os.getuid())) as f:
            if "memory" not in f.read().split():
                return None
    except OSError:
        return None
    return busctl


@unittest.skipUnless(real_scope_possible(),
                     "no busctl, user bus or memory delegation")
class RealScope(unittest.TestCase):
    """One real transient scope around `sleep`, tiny limits, no load."""

    def systemctl(self, *args):
        return subprocess.run(["systemctl", "--user", *args],
                              capture_output=True, text=True, timeout=10)

    def test_scope_with_limits_and_cleanup(self):
        sleeper = subprocess.Popen(["sleep", "30"])
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        name = "loadguard-test-%d.scope" % sleeper.pid
        props = {"MemoryHigh": 16 << 20, "MemoryMax": 32 << 20,
                 "MemorySwapMax": 0, "CPUWeight": 10}
        self.assertTrue(confine.start_scope(
            real_scope_possible(), name, [sleeper.pid], props,
            "loadguard: unit test"))
        self.assertTrue(confine.wait_attached("", sleeper.pid, name))
        self.assertTrue(confine.cgroup("", sleeper.pid).endswith(
            "/app-loadguard.slice/" + name))
        shown = self.systemctl("show", name, "-p", "MemoryHigh", "-p",
                               "MemoryMax", "-p", "MemorySwapMax", "-p",
                               "CPUWeight", "-p", "OOMPolicy").stdout
        for line in ("MemoryHigh=16777216", "MemoryMax=33554432",
                     "MemorySwapMax=0", "CPUWeight=10", "OOMPolicy=continue"):
            self.assertIn(line, shown.splitlines())
        sleeper.kill()
        sleeper.wait()
        deadline = time.monotonic() + 5
        while self.systemctl("list-units", "--all", "--no-legend",
                             name).stdout.strip():
            self.assertLess(time.monotonic(), deadline, "scope lingers")
            time.sleep(0.05)


if __name__ == "__main__":
    unittest.main()
