"""Parity (k19, L5 a): the TypeScript port of the decision (ts/, bundled to
dist/driver.js) answers every fixture exactly as the C hook does.

The C test driver (-DLOADGUARD_TEST) is the oracle until the switch to Bun
(B7). Every test class below is a driver-based class of test_throttle,
test_learn or test_hook_binary, run again with each call of the C driver
mirrored through dist/driver.js — same arguments, stdin and environment —
and the two compared on exit code, stdout and stderr. The C result is what
the inherited assertions then check, so each fixture is judged twice: by
the test as written, and by the byte-for-byte comparison.

The watcher (B5): the driver's `watch SESSION ROOT...` and the production
`--watch PID` (dist/watch.js PID) are mirrored the same way, and since a
watcher writes, the learned list and the runtime dir are compared too: the
C run's changes are rolled back, the TS run repeats them, and both must
leave the same files, bytes and modes behind.

The confinement (B5): lib/loadguard/confine.py stays the oracle. The classes
of test_confine that drive it run again with the module replaced, inside
test_confine, by a twin that calls the Python function and then the same
function of ts/scope.ts (`driver.js scope-call`) on the rolled-back fixture:
same answer (or the same exception class), same fixture files after,
including the fake busctl's log of every argv. Launching the watcher, the
confine entry and the production watcher are checked by TS-only classes
below, on the fake host of test_confine.

Bun: $LOADGUARD_BUN, else `bun` on PATH; without one every test here is
skipped, with the reason. Bun's caches go to a temporary directory, never
~/.bun. Without a C compiler the inherited setUpModule skips as well.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import test_confine as tc
import test_hook_binary as thb
import test_learn as tl
import test_throttle as tt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "lib"))
from loadguard import confine as py_confine  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVER_JS = os.path.join(ROOT, "dist", "driver.js")
CONFINE_JS = os.path.join(ROOT, "dist", "confine.js")
WATCH_JS = os.path.join(ROOT, "dist", "watch.js")
BUN = os.environ.get("LOADGUARD_BUN") or shutil.which("bun")
STATE = {}


def setUpModule():
    if BUN is None:
        raise unittest.SkipTest("no Bun ($LOADGUARD_BUN or bun on PATH): "
                                "the TS port goes unchecked")
    STATE["tmp"] = tempfile.mkdtemp(prefix="loadguard-parity-")
    tt.setUpModule()
    tl.setUpModule()


def tearDownModule():
    tt.tearDownModule()
    tl.tearDownModule()
    if "tmp" in STATE:
        shutil.rmtree(STATE["tmp"], ignore_errors=True)


def bun_env(env):
    """The test's environment, plus Bun's caches in the scratch directory."""
    env = dict(env)
    tmp = STATE["tmp"]
    env.update(BUN_INSTALL=os.path.join(tmp, "bun"),
               BUN_INSTALL_CACHE_DIR=os.path.join(tmp, "cache"),
               XDG_CACHE_HOME=os.path.join(tmp, "xdg-cache"),
               BUN_RUNTIME_TRANSPILER_CACHE_PATH="0")
    return env


def run_ts(args, stdin, env, timeout=30, driver=None):
    """dist/driver.js as the starters run a bundle: no project config."""
    return subprocess.run(
        [BUN, "--no-install", "--config=/dev/null", "--no-env-file",
         driver or DRIVER_JS] + list(args),
        input=stdin, capture_output=True, timeout=timeout, env=bun_env(env))


def compare(c, ts, argv, stdin):
    if (ts.returncode, ts.stdout, ts.stderr) != (c.returncode, c.stdout,
                                                c.stderr):
        raise AssertionError(
            "TS driver differs from the C driver\n  args:  %r\n  stdin: %r\n"
            "  C:  rc=%r stdout=%r stderr=%r\n  TS: rc=%r stdout=%r stderr=%r"
            % (argv[1:], stdin[:300], c.returncode, c.stdout, c.stderr[:500],
               ts.returncode, ts.stdout, ts.stderr[:500]))


def snapshot(dirs):
    """{path: (kind, mode, content)} of everything below dirs."""
    out = {}
    for top in dirs:
        if not top or not os.path.isdir(top):
            continue
        for base, subdirs, files in os.walk(top):
            for name in subdirs + files:
                path = os.path.join(base, name)
                st = os.lstat(path)
                mode = stat.S_IMODE(st.st_mode)
                if stat.S_ISDIR(st.st_mode):
                    out[path] = ("dir", mode, None)
                elif stat.S_ISLNK(st.st_mode):
                    out[path] = ("link", None, os.readlink(path))
                elif stat.S_ISREG(st.st_mode):
                    with open(path, "rb") as f:
                        out[path] = ("file", mode, f.read())
                else:
                    out[path] = ("other", mode, None)
    return out


def restore(before, after):
    """Undo what changed between two snapshots; unchanged entries (a lock
    file a test holds) are not touched."""
    for path in sorted(set(after) - set(before), reverse=True):
        if after[path][0] == "dir":
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.lexists(path):
            os.unlink(path)
    for path in sorted(before):
        kind, mode, content = before[path]
        if after.get(path) == before[path]:
            continue
        if kind == "dir":
            os.makedirs(path, exist_ok=True)
            os.chmod(path, mode)
        elif kind == "file":
            if os.path.lexists(path) and not os.path.isfile(path):
                shutil.rmtree(path, ignore_errors=True)
            with open(path, "wb") as f:
                f.write(content)
            os.chmod(path, mode)
        elif kind == "link":
            if os.path.lexists(path):
                os.unlink(path)
            os.symlink(content, path)


def same_files(oracle, ts, what):
    if oracle != ts:
        diff = sorted(p for p in set(oracle) | set(ts)
                      if oracle.get(p) != ts.get(p))
        raise AssertionError(
            "TS leaves other files than the oracle\n  call: %r\n%s" % (
                what, "\n".join("  %s\n    oracle: %r\n    TS:     %r" % (
                    p, oracle.get(p), ts.get(p)) for p in diff[:10])))


class Parity:
    """Mixin: every C driver call of the test gets its TS twin."""

    compared = 0

    def twin(self, run, driver):
        def mirrored(argv, stdin=b"{}", env=None, timeout=30):
            env = tt.base_env() if env is None else env
            watcher = argv[0] == driver() and argv[1:2] == ["watch"]
            production = (argv[0] == tl.BIN.get("hook") and len(argv) == 3
                          and argv[1] == "--watch")
            if not (watcher or production):
                proc = run(argv, stdin, env, timeout)
                if argv[0] == driver():
                    ts = run_ts(argv[1:], stdin, env, timeout)
                    type(self).compared += 1
                    compare(proc, ts, argv, stdin)
                return proc
            # A watcher writes: roll the C run back, let TS repeat it.
            dirs = [env.get("XDG_STATE_HOME"), env.get("XDG_RUNTIME_DIR")]
            before = snapshot(dirs)
            proc = run(argv, stdin, env, timeout)
            after_c = snapshot(dirs)
            restore(before, after_c)
            if watcher:
                ts = run_ts(argv[1:], stdin, env, timeout)
            else:
                ts = run_ts(argv[2:], stdin, env, timeout, driver=WATCH_JS)
            type(self).compared += 1
            compare(proc, ts, argv, stdin)
            same_files(after_c, snapshot(dirs), argv)
            return proc
        return mirrored

    def setUp(self):
        for module in (tt, tl):
            patcher = mock.patch.object(
                module, "run",
                self.twin(module.run, lambda m=module: m.BIN["driver"]))
            patcher.start()
            self.addCleanup(patcher.stop)
        super().setUp()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        # Not vacuous: a class whose driver calls were never mirrored (a
        # renamed binary, a call that bypasses the patched run) fails here.
        if cls.compared == 0:
            raise AssertionError("%s: no C driver call was mirrored through "
                                 "dist/driver.js" % cls.__name__)


class Matcher(Parity, tt.Matcher):
    pass


class Measure(Parity, tt.Measure):
    pass


class Slots(Parity, tt.Slots):
    pass


class Decide(Parity, tt.Decide):
    pass


class Report(Parity, tt.Report):
    pass


class Context(Parity, tt.Context):
    pass


class CodexPayloads(Parity, tt.CodexPayloads):
    pass


class Calibration(Parity, tt.Calibration):
    pass


class Extract(Parity, tl.Extract):
    pass


class LearnedHook(Parity, tl.Hook):
    pass


class Watch(Parity, tl.Watch):
    """The watcher: driver `watch` and production --watch, files included."""


class Extraction(Parity, thb.Extraction):
    """The payload extraction (k18's command mode) through run_bin."""

    def run_bin(self, argv, stdin=b""):
        proc = super().run_bin(argv, stdin)
        if argv[0] == self.driver:
            ts = run_ts(argv[1:], stdin, os.environ)
            type(self).compared += 1
            compare(proc, ts, argv, stdin)
        return proc


class Harness(unittest.TestCase):
    """The comparison itself can fail, and the TS side really runs."""

    def test_ts_driver_answers(self):
        proc = run_ts(["heavy"], tt.payload("nice -n 10 make -j4 test"),
                      tt.base_env())
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (0, b"make test", b""))

    def test_a_difference_fails(self):
        stub = os.path.join(STATE["tmp"], "stub.js")
        with open(stub, "w", encoding="utf-8") as f:
            f.write('process.stdout.write("prove");\n')
        c = subprocess.run([tt.BIN["driver"], "heavy"],
                           input=tt.payload("make test"),
                           capture_output=True, env=tt.base_env())
        ts = run_ts(["heavy"], tt.payload("make test"), tt.base_env(),
                    driver=stub)
        with self.assertRaises(AssertionError):
            compare(c, ts, [tt.BIN["driver"], "heavy"], b"")


class Edges(unittest.TestCase):
    """Inputs no other test feeds, where a port drifts first: cJSON's
    reading of odd JSON (duplicate keys, lone surrogates, an escaped NUL,
    bytes <= 32 as whitespace, nesting), strtod and printf on odd figures
    (ties, -0, hex, inf), byte-level cuts of labels and holders, a learned
    list with odd lines and peaks. Each case only demands C == TS."""

    compared = 0

    def setUp(self):
        d = tempfile.mkdtemp(prefix="loadguard-edges-")
        self.addCleanup(shutil.rmtree, d, True)
        self.dir = d

    @classmethod
    def tearDownClass(cls):
        if cls.compared == 0:
            raise AssertionError("Edges: nothing compared")

    def same(self, args, stdin=b"{}", **env):
        environ = tt.base_env(**env)
        c = subprocess.run([tt.BIN["driver"]] + args, input=stdin,
                           capture_output=True, timeout=30, env=environ)
        ts = run_ts(args, stdin, environ)
        type(self).compared += 1
        compare(c, ts, [tt.BIN["driver"]] + args, stdin)
        return c

    def root(self, name="root"):
        root = os.path.join(self.dir, name)
        os.makedirs(os.path.join(root, "proc"), exist_ok=True)
        return root

    def write(self, root, rel, data):
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode())

    def test_payload_json(self):
        thrash = tt.THRASH
        cases = [
            b'{"tool_name":"Bash","tool_name":"Read",'
            b'"tool_input":{"command":"prove","command":"ls"}}',
            b'{"tool_name":"Read","tool_name":"Bash",'
            b'"tool_input":{"command":"ls","command":"prove"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove \\ud800"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove \\udc00"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove \\ud800x"}}',
            b'{"tool_name":"Bash","tool_input":'
            b'{"command":"prove \\ud800\\u0041"}}',
            b'{"tool_name":"Bash","tool_input":'
            b'{"command":"prove \\ud83d\\ude00"}}',
            b'{"tool_name":"Bash","tool_input":'
            b'{"command":"ls\\u0000; prove"}}',
            b'{"tool_name":"Bash\\u0000x","tool_input":{"command":"prove"}}',
            b'{"tool_name\\u0000x":"Bash","tool_input":{"command":"prove"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"pro\\uzzzzve"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove\\u12"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove\\q"}}',
            b'{"tool_name":"Bash","tool_input":'
            b'{"command":"a\tb\x01; prove"}}',
            b'\x01\x0b{"tool_name":"Bash","tool_input":'
            b'{"command":"prove"}}\x1f',
            b'\xef\xbb\xbf{"tool_name":"Bash","tool_input":'
            b'{"command":"prove"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove"}} x',
            b'{"tool_name":"Bash","n":[1.,-.5,01,-0,1e5,2E-3,1e999],'
            b'"tool_input":{"command":"prove"}}',
            b'{"tool_name":"Bash","n":1e,"tool_input":{"command":"prove"}}',
            b'{"tool_name":"Bash","n":+1,"tool_input":{"command":"prove"}}',
            b'{"tool_name":"Bash","n":nul,"tool_input":{"command":"prove"}}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove"},}',
            b'{"tool_name":"Bash","tool_input":["prove"]}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove"}',
            b'{"tool_name":"Bash","tool_input":{"command":"prove"}}   ',
            b'{"tool_name":"Bash","tool_input":{"command":"pr\\/ove \\b\\f"}}',
            b'["tool_name","Bash"]', b'"Bash"', b'7', b'null', b' ', b'{',
            b'{"tool_name":"Bash","x":' + b'[' * 999 + b']' * 999 +
            b',"tool_input":{"command":"prove"}}',
            b'{"tool_name":"Bash","x":' + b'[' * 1000 + b']' * 1000 +
            b',"tool_input":{"command":"prove"}}',
        ]
        for stdin in cases:
            with self.subTest(stdin=stdin[:80]):
                for args in (["command"], ["heavy"], ["decide", thrash],
                             ["explain", thrash]):
                    self.same(args, stdin)

    def test_extract_odd_argv(self):
        for doc in (b'{"argv":{"a":"bash","b":"-c","c":"x y"}}',
                    b'{"argv":["bash","-c",7,"x"],"harness":"codex"}',
                    b'{"argv":["sh","-lc","eval \\"a\\\\$b\\" && pwd -P >|'
                    b' /tmp/claude-1-cwd"],"harness":"claude"}',
                    b'{"argv":["zsh","-c","x eval \'a\'\\\\\'\'b\' < /dev/null'
                    b' && pwd -P >| /tmp/c-cwd"]}',
                    b'{"argv":["bash","-c","eval \'x\' && pwd -P >| -cwd"]}',
                    b'{"argv":"bash"}', b'{"harness":"codex"}', b'[]'):
            with self.subTest(doc=doc):
                self.same(["extract"], doc)

    def test_odd_figures(self):
        root = self.root()
        for full in ("0.25", "0.05", "0.125", "0.375", "-0", "-0.00", "1e1",
                     "0x10", "0x1.8p3", "inf", "nan", "  12.5", "100",
                     "100.0001", "45.47", "9.95", "9.9999999", ".5", "1.",
                     "10.25", "12.75", "10.35", "+3", "--3", "1e-7", "99.95"):
            self.write(root, "proc/pressure/memory",
                       "some avg10=%s avg60=0 avg300=0 total=1\n"
                       "full avg10=%s avg60=0 avg300=0 total=1\n"
                       % (full, full))
            with self.subTest(full=full):
                self.same(["measure", root])
                self.same(["decide", root], tt.payload("prove"))
                self.same(["decide", root],
                          tt.event_payload("UserPromptSubmit"))
                self.same(["report", root])
        for total, free in (("18446744073709551615", "0"),
                            ("18446744073709551616", "0"),
                            ("18446744073709551615", "1"),
                            ("400000000000000000", "1"), ("5", "6"),
                            ("0", "0"), ("100", "100"), ("100", "9")):
            self.write(root, "proc/meminfo",
                       "MemTotal: 1 kB\nSwapTotal: %s kB\nSwapFree:\t%s kB\n"
                       % (total, free))
            with self.subTest(total=total, free=free):
                self.same(["measure", root])
                self.same(["report", root])
        for text in ("xSwapTotal: 100 kB\nSwapTotal: 50 kB\nSwapFree: 0 kB\n",
                     "SwapTotal: x\nSwapTotal: 50 kB\nSwapFree: 0 kB\n",
                     "SwapFree: 1 kB\nSwapTotal: 4 kB\n"):
            self.write(root, "proc/meminfo", text)
            with self.subTest(meminfo=text):
                self.same(["measure", root])
        for i, (size, data) in enumerate((("100", "33"), ("0", "5"),
                                          ("18446744073709551615", "9"),
                                          ("x", "1"), ("7", "x"),
                                          ("200000000000000000", "1"))):
            self.write(root, "sys/block/zram%d/disksize" % i, size + "\n")
            self.write(root, "sys/block/zram%d/mm_stat" % i,
                       data + " 2 3\n")
            with self.subTest(zram=i):
                self.same(["measure", root])

    def test_odd_processes(self):
        root = self.root()
        self.write(root, "proc/meminfo", "SwapTotal: 0 kB\n")
        cg = tt.SLICE_CGROUP
        tt.add_process(root, 100, 1, "bash",
                       ["/usr/bin/prove", "ä" * 30, "t/"], cg,
                       tt.HOME + "/dev/" + "ü" * 90)
        tt.add_process(root, 101, 1, "bash", ["make", "x" * 40, "test"], cg,
                       tt.HOME)
        tt.add_process(root, 102, 1, "b) (c", ["cargo", "+n", "test"], cg,
                       "/")
        tt.add_process(root, 103, 1, "x", ["npm test --x  y"], cg, None)
        tt.add_process(root, 104, 1, "x", ["docker", "run", "\x1b[31m"],
                       cg, tt.HOME + "x/y")
        tt.add_process(root, 105, 1, "x", ["cpanm", "x"], cg, "/tmp")
        os.unlink(os.path.join(root, "proc", "105", "cwd"))
        os.symlink(b"/tmp/\xff\xfe", os.path.join(root.encode(), b"proc",
                                                   b"105", b"cwd"))
        self.write(root, "proc/0106/cgroup", cg + "\n")
        self.write(root, "proc/0106/stat", "106 (x) S 1 0\n")
        self.write(root, "proc/0106/cmdline", "prove\0")
        self.write(root, "proc/107/cgroup", cg + "\n")
        self.write(root, "proc/107/stat", "107 (x) S +99999999999 0\n")
        self.write(root, "proc/107/cmdline", "prove\0\0\0")
        self.write(root, "proc/108/cgroup", cg + "\n")
        self.write(root, "proc/108/stat", "108 (x)")
        self.write(root, "proc/108/cmdline", "prove\0")
        for home in (tt.HOME, tt.HOME + "/", "/", "", "relative"):
            with self.subTest(home=home):
                self.same(["slots", root], HOME=home)
                self.same(["decide", root], tt.payload("prove"), HOME=home,
                          LOADGUARD_HEAVY_SLOTS="1")
                self.same(["explain", root], tt.payload("prove"),
                          HOME=home)

    def test_odd_learned_lists(self):
        state = os.path.join(self.dir, "state")
        path = os.path.join(state, "loadguard", "learned.jsonl")
        root = self.root()
        self.write(root, "proc/meminfo",
                   "SwapTotal: 100 kB\nSwapFree: 0 kB\n")

        def line(command, peak=None, last="2026-09-21T05:18:28Z"):
            doc = {"command": command, "last_seen": last}
            if peak is not None:
                doc["peak_rss"] = peak
            return json.dumps(doc).encode()

        lists = [
            line("x", 1572864) + b"\n",                     # 1.5 MiB: a tie
            line("x", 1073741824 * 1.25) + b"\n",           # 1.25 GiB
            line("x", 2621440) + b"\n",                     # 2.5 MiB
            line("x", 1e300) + b"\n",
            b'{"command":"x","peak_rss":1e999}\n',
            line("x", -5, "2026-9-21") + b"\n",
            line("x", "big", "20260921") + b"\n",
            b'{"command":"y"}\n{"command":"x","command":"z"}\n',
            b'\xef\xbb\xbf  ' + line("x") + b'\n',
            line("x") + b'\x00\n',
            line("x") + b' \x0b\x0c\r\n',
            b'{"command":"x\\u0000y"}\n',
            b'{"command":"\xff\xfe x"}\n{"command":"x"}\n',
            b'\n' * 256 + line("x") + b"\n",
            b'\n' * 255 + line("x"),
            b'[' + line("x") + b']\n',
        ]
        for i, data in enumerate(lists):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
            with self.subTest(list=i):
                for command in ("x", "y", "z"):
                    self.same(["decide", root], tt.payload(command),
                              XDG_STATE_HOME=state)
                    self.same(["explain", root], tt.payload(command),
                              XDG_STATE_HOME=state)
                self.same(["report", root], XDG_STATE_HOME=state)
        for xdg, home in (("relative", self.dir), ("", self.dir),
                          (None, "relative"), (None, None)):
            env = {} if xdg is None else {"XDG_STATE_HOME": xdg}
            with self.subTest(xdg=xdg, home=home):
                environ = dict(tt.base_env(**env))
                if xdg is None:
                    del environ["XDG_STATE_HOME"]
                if home is None:
                    del environ["HOME"]
                else:
                    environ["HOME"] = home
                c = subprocess.run([tt.BIN["driver"], "report", root],
                                   input=b"{}", capture_output=True,
                                   env=environ)
                compare(c, run_ts(["report", root], b"{}", environ),
                        [tt.BIN["driver"], "report"], b"{}")
                type(self).compared += 1

    def test_production_explain(self):
        # --explain as the CLI calls the production binary, where the
        # answer does not depend on the live host: light commands read the
        # learned list only, a payload that is no Bash call nothing.
        for stdin in (tt.payload("git status"), tt.payload("ls"),
                      b'{"tool_name":"Read"}', b"", b"broken"):
            for env in ({}, {"LOADGUARD_THROTTLE": "0"},
                        {"LOADGUARD_PSI_FULL": "x"}):
                with self.subTest(stdin=stdin, env=env):
                    environ = tt.base_env(**env)
                    c = subprocess.run([tt.BIN["hook"], "--explain"],
                                       input=stdin, capture_output=True,
                                       timeout=30, env=environ)
                    compare(c, run_ts(["--explain"], stdin, environ),
                            [tt.BIN["hook"], "--explain"], stdin)
                    type(self).compared += 1


# --- the confinement: lib/loadguard/confine.py against ts/scope.ts ----------------

def py_kind(e):
    for kind in (OSError, IndexError, ValueError):
        if isinstance(e, kind):
            return kind.__name__
    return type(e).__name__


def user_of(uid):
    """What getpwuid (as the test mocks it) answers for uid."""
    try:
        return py_confine.pwd.getpwuid(uid).pw_name
    except KeyError:
        return None


# confine.py's name -> (ts/scope.ts's name, its arguments from Python's)
SCOPE_FNS = {
    "find_session": ("findSession", lambda root, start: [root, start]),
    "session_name": ("sessionName", lambda root, pid: [root, pid]),
    "descendants": ("descendants", lambda root, pid: [root, pid]),
    "cgroup": ("cgroup", lambda root, pid: [root, pid]),
    "limits": ("limits", lambda root, environ: [root, dict(environ)]),
    "delegated": ("delegated", lambda root, run, uid: [root, run, uid]),
    "lingering": ("lingering", lambda root, uid: [root, user_of(uid)]),
    "scope_name": ("scopeName", lambda sid, pid: [sid, pid]),
    "in_loadguard_scope": ("inLoadguardScope", lambda path: [path]),
    "busctl_argv": ("busctlArgv", lambda busctl, name, pids, props, d:
                    [busctl, name, list(pids), dict(props), d]),
    "confine": ("confine", lambda sid, start=None, root="", environ=None,
                uid=None, me=None: [sid, {
                    "root": root, "environ": dict(environ), "uid": uid,
                    "user": user_of(uid), "start": start, "me": me,
                    "confirmS": py_confine.CONFIRM_S}]),
}


class ScopeTwin:
    """Stands in for lib/loadguard/confine.py inside test_confine: a call of
    a ported function runs the Python, rolls the fixture back, runs the
    same call through `driver.js scope-call`, and demands the same answer
    (or exception class) and the same files, the fake busctl's log of
    argvs included. Everything else is the real module; attributes set on
    the twin (CONFIRM_S) are set on the module."""

    def __init__(self, test):
        object.__setattr__(self, "_test", test)

    def __setattr__(self, name, value):
        setattr(py_confine, name, value)

    def __getattr__(self, name):
        real = getattr(py_confine, name)
        if name not in SCOPE_FNS:
            return real
        fn, convert = SCOPE_FNS[name]
        test = self._test

        def twin(*args, **kwargs):
            tree = getattr(test, "t", None)
            dirs = [os.path.dirname(tree.root)] if tree else []
            before = snapshot(dirs)
            try:
                py, raised = ("value", real(*args, **kwargs)), None
            except Exception as e:  # noqa: BLE001 — compared, then re-raised
                py, raised = ("raise", py_kind(e)), e
            after_py = snapshot(dirs)
            restore(before, after_py)
            call = {"fn": fn, "args": convert(*args, **kwargs)}
            proc = run_ts(["scope-call"], json.dumps(call).encode(),
                          dict(os.environ))
            type(test).compared += 1
            if proc.returncode != 0 or proc.stderr:
                raise AssertionError("scope-call failed: %r\n%s" % (
                    call, proc.stderr.decode(errors="replace")[:2000]))
            got = json.loads(proc.stdout)
            want = {py[0]: json.loads(json.dumps(py[1]))}
            if got != want:
                raise AssertionError(
                    "ts/scope.ts differs from confine.py\n  call: %r\n"
                    "  Python: %r\n  TS:     %r" % (call, want, got))
            same_files(after_py, snapshot(dirs), call)
            if raised is not None:
                raise raised
            return py[1]
        return twin


class ScopeParity:
    """Mixin: test_confine's `confine` is the twin for the whole test."""

    compared = 0

    def setUp(self):
        patcher = mock.patch.object(tc, "confine", ScopeTwin(self))
        patcher.start()
        self.addCleanup(patcher.stop)
        super().setUp()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        if cls.compared == 0:
            raise AssertionError("%s: no confine.py call was mirrored "
                                 "through ts/scope.ts" % cls.__name__)


class FindSession(ScopeParity, tc.FindSession):
    pass


class Descendants(ScopeParity, tc.Descendants):
    pass


class Limits(ScopeParity, tc.Limits):
    pass


class Delegation(ScopeParity, tc.Delegation):
    pass


class BusctlArgv(ScopeParity, tc.BusctlArgv):
    pass


class Confine(ScopeParity, tc.Confine):
    pass


class FailOpen(ScopeParity, tc.FailOpen):
    pass


class ScopeTwinFails(unittest.TestCase):
    """The twin can fail: a TS answer that differs is caught."""

    compared = 0

    def test_a_different_answer_fails(self):
        twin = ScopeTwin(self)
        with mock.patch.dict(SCOPE_FNS, {"scope_name": (
                "scopeName", lambda sid, pid: [sid, pid + 1])}):
            with self.assertRaises(AssertionError):
                twin.scope_name("abc", 7)


# --- starting the watcher: learn.start_watcher's tests, for ts/scope.ts -------------

# Records what the watcher's process got: argv, pid, stat (after a moment,
# so the parent's setPriority has landed), stdio, cwd, the environment.
TS_WATCHER_STUB = """#!/bin/sh
sleep 0.3
fds=$(readlink /proc/$$/fd/0 /proc/$$/fd/1 /proc/$$/fd/2)
{ echo "$*"; echo $$; cat /proc/$$/stat; echo; echo "$fds"; pwd; env; } \\
  > "$RECORD.tmp" && mv "$RECORD.tmp" "$RECORD"
"""


class Launcher(tc.Base):
    """startWatcher of ts/scope.ts on the fake host of test_confine: the
    cases of test_learn.Launcher, with the Bun launch in place of the
    binary's: process.execPath (here a stub) with the starters' isolation
    flags, dist/watch.js and the pid, without the variables the starters
    remove, detached, nice 10, moved into the scope after "attached"."""

    def setUp(self):
        super().setUp()
        tmp = os.path.dirname(self.t.root)
        self.entry = os.path.join(tmp, "dist", "watch.js")
        os.makedirs(os.path.dirname(self.entry))
        with open(self.entry, "w") as f:
            f.write("// stands in for dist/watch.js\n")
        self.bun = os.path.join(tmp, "bun")
        with open(self.bun, "w") as f:
            f.write(TS_WATCHER_STUB)
        os.chmod(self.bun, 0o755)
        self.record = os.path.join(tmp, "record")
        self.t.env["RECORD"] = self.record

    def start(self, status, start=2549600, entry=None, **env):
        environ = dict(self.t.env, PATH=self.t.bin + ":/usr/bin:/bin",
                       BUN_OPTIONS="--preload /x.js", NODE_PATH="/x",
                       BUN_INSPECT="ws://x", KEEP_ME="1", **env)
        call = {"fn": "startWatcher", "args": [status, {
            "root": self.t.root, "environ": environ, "start": start,
            "entry": self.entry if entry is None else entry,
            "execPath": self.bun}]}
        proc = run_ts(["scope-call"], json.dumps(call).encode(),
                      dict(os.environ))
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        return json.loads(proc.stdout)["value"]

    def recorded(self):
        deadline = time.monotonic() + 5
        while not os.path.exists(self.record):
            self.assertLess(time.monotonic(), deadline, "watcher not run")
            time.sleep(0.02)
        with open(self.record) as f:
            lines = f.read().split("\n")
        args, pid, stat_line = lines[:3]
        fields = stat_line[stat_line.rindex(")") + 2:].split()
        return {"args": args, "pid": int(pid), "sid": int(fields[3]),
                "nice": int(fields[16]), "fds": lines[4:7], "cwd": lines[7],
                "env": dict(line.split("=", 1) for line in lines[8:]
                            if "=" in line)}

    def argv(self, pid):
        return "--no-install --config=/dev/null --no-env-file %s %d" % (
            self.entry, pid)

    def test_after_attached(self):
        claude = self.reuben_session()
        self.assertEqual(py_confine.confine(
            tc.SESSION, start=2549600, root=self.t.root, environ=self.t.env,
            uid=tc.UID, me=2549601), "attached")
        before = len(self.t.calls())
        self.assertEqual(self.start("attached"), "started")
        got = self.recorded()
        self.assertEqual(got["args"], self.argv(claude))
        # Detached: its own session, stdio on /dev/null, cwd /, nice 10.
        self.assertEqual(got["sid"], got["pid"])
        self.assertEqual(got["fds"], ["/dev/null"] * 3)
        self.assertEqual(got["cwd"], "/")
        self.assertEqual(got["nice"], 10)
        # Without what the starters remove; the rest as the hook had it.
        for name in ("BUN_OPTIONS", "NODE_PATH", "BUN_INSPECT"):
            self.assertNotIn(name, got["env"])
        self.assertEqual(got["env"].get("KEEP_ME"), "1")
        # The hook sat outside the scope: the watcher is moved in.
        (attach,) = self.t.calls()[before:]
        self.assertEqual(attach[6:12], [
            "AttachProcessesToUnit", "ssau", "loadguard-091fbf8e-%d.scope"
            % claude, "", "1", str(got["pid"])])

    def test_after_already_no_move(self):
        claude = self.reuben_session()
        scope = tc.SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % claude
        self.t.write("/proc/%d/cgroup" % claude, "0::%s\n" % scope)
        self.assertEqual(self.start("already"), "started")
        self.assertEqual(self.recorded()["args"], self.argv(claude))
        self.assertEqual(self.t.calls(), [])

    def test_nested_claude_asks_for_the_scopes_owner(self):
        outer = self.reuben_session()
        scope = tc.SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % outer
        self.t.write("/proc/%d/cgroup" % outer, "0::%s\n" % scope)
        self.t.proc(3000, outer, "bash", cgroup=scope)
        self.t.proc(3001, 3000, "claude", ["claude", "-p", "x"], cgroup=scope)
        self.t.proc(3002, 3001, "python3", cgroup=scope)
        self.assertEqual(self.start("already", start=3002), "started")
        self.assertEqual(self.recorded()["args"], self.argv(outer))

    def test_not_started(self):
        claude = self.reuben_session()
        scope = tc.SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % claude
        self.t.write("/proc/%d/cgroup" % claude, "0::%s\n" % scope)
        for status in ("no-linger", "disabled", "start-failed",
                       "unconfirmed", "no-session", "stub"):
            with self.subTest(status=status):
                self.assertEqual(self.start(status), "not-confined")
        self.assertEqual(self.start("already", LOADGUARD_LEARN="0"),
                         "disabled")
        self.assertEqual(self.start("already", entry=self.entry + ".gone"),
                         "no-entry")
        self.assertEqual(self.start("already", entry=self.t.root),
                         "no-entry")
        time.sleep(0.5)
        self.assertFalse(os.path.exists(self.record))

    def test_session_not_in_a_scope(self):
        self.reuben_session()
        self.assertEqual(self.start("already"), "not-confined")
        time.sleep(0.5)
        self.assertFalse(os.path.exists(self.record))


class ConfineEntry(unittest.TestCase):
    """dist/confine.js, as test_confine.Entry checks hooks/loadguard-confine:
    exit 0, empty stdout, whatever it gets. XDG_RUNTIME_DIR is stripped (the
    real session above the runner must not be moved) and LOADGUARD_LEARN=0
    (no real watcher is started for it)."""

    def run_entry(self, stdin, args=()):
        env = {"PATH": "/usr/bin:/bin", "LOADGUARD_LEARN": "0"}
        return run_ts(list(args), stdin, env, timeout=10, driver=CONFINE_JS)

    def test_silent_on_any_payload(self):
        for stdin in (b"", b"{", b"[]", b"null", b"\xff\xfe",
                      b'{"session_id": 7}', b'{"session_id": "\\ud800"}',
                      b'\xef\xbb\xbf{"session_id": "abc"}',
                      b'{"session_id": "abc", "hook_event_name": "SessionStart",'
                      b' "source": "startup"}'):
            with self.subTest(stdin=stdin):
                proc = self.run_entry(stdin)
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))

    def test_status_flag(self):
        proc = self.run_entry(b'{"session_id": "abc"}', ["--status"])
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        # As test_confine.Entry: every answer here returns before busctl.
        self.assertIn(proc.stdout, (b"no-session\n", b"no-bus\n",
                                    b"already\n", b"no-linger\n",
                                    b"no-cgroup-v2\n"))

    def test_same_status_as_the_python_hook(self):
        for stdin in (b'{"session_id": "abc"}', b"garbage"):
            with self.subTest(stdin=stdin):
                py = subprocess.run(
                    [tc.ENTRY, "--status"], input=stdin, capture_output=True,
                    timeout=10, env={"PATH": "/usr/bin:/bin",
                                     "LOADGUARD_LEARN": "0"})
                ts = self.run_entry(stdin, ["--status"])
                self.assertEqual((ts.returncode, ts.stdout, ts.stderr),
                                 (py.returncode, py.stdout, py.stderr))


class ProductionWatch(unittest.TestCase):
    """dist/watch.js, as test_learn.ProductionWatchMode checks --watch:
    quiet, never blocks on stdin, ends at once where there is nothing to
    watch; any other number of arguments does nothing."""

    def test_nothing_to_watch_ends_at_once(self):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.addCleanup(os.close, w)
        for args in ([""], ["x"], ["0"], ["1"], ["-5"], ["12x"],
                     ["99999999999"], [str(os.getpid())], ["4194303"], [],
                     ["1", "2"]):
            with self.subTest(args=args):
                start = time.monotonic()
                proc = subprocess.run(
                    [BUN, "--no-install", "--config=/dev/null",
                     "--no-env-file", WATCH_JS] + args, stdin=r,
                    capture_output=True, timeout=10,
                    env=bun_env(tt.base_env()))
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))
                self.assertLess(time.monotonic() - start, 5)
