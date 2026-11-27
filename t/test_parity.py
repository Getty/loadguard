"""Parity (k19, L5 a): the TypeScript port of the decision (ts/, bundled to
dist/driver.js) answers every fixture exactly as the C hook does.

The C test driver (-DLOADGUARD_TEST) is the oracle until the switch to Bun
(B7). Every test class below is a driver-based class of test_throttle,
test_learn or test_hook_binary, run again with each call of the C driver
mirrored through dist/driver.js — same arguments, stdin and environment —
and the two compared on exit code, stdout and stderr. The C result is what
the inherited assertions then check, so each fixture is judged twice: by
the test as written, and by the byte-for-byte comparison.

Not mirrored: `watch SESSION ROOT...` (the watcher is ported in B5).

Bun: $LOADGUARD_BUN, else `bun` on PATH; without one every test here is
skipped, with the reason. Bun's caches go to a temporary directory, never
~/.bun. Without a C compiler the inherited setUpModule skips as well.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import test_hook_binary as thb
import test_learn as tl
import test_throttle as tt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVER_JS = os.path.join(ROOT, "dist", "driver.js")
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


class Parity:
    """Mixin: every C driver call of the test gets its TS twin."""

    compared = 0

    def twin(self, run, driver):
        def mirrored(argv, stdin=b"{}", env=None, timeout=30):
            proc = run(argv, stdin, env, timeout)
            if argv[0] == driver() and argv[1:2] != ["watch"]:
                ts = run_ts(argv[1:], stdin,
                            tt.base_env() if env is None else env, timeout)
                type(self).compared += 1
                compare(proc, ts, argv, stdin)
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
