"""Stage 2+3 (k4): the hook denies heavy commands under memory pressure or
when every heavy slot is busy, and tells the model why.

setUpModule builds two binaries into a temporary directory:
  hook    the production main (FLAGS + -Werror): reads the live /proc only
  driver  -DLOADGUARD_TEST (TEST_FLAGS: -Werror, ASan, UBSan): the matcher,
          the measurement, the slot scan and the whole decision against a
          fixture root
Nothing here produces load. Pressure comes from the recorded and
reconstructed trees in t/fixtures/proc/, running processes from the JSON
specs in t/fixtures/procs/ (see the README there), calibration from
~/load-incidents read-only. Without a C compiler every test is skipped.
"""

import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
FIXTURES = os.path.join(ROOT, "t", "fixtures")
CALM = os.path.join(FIXTURES, "proc", "reuben-recorded-20260926")
THRASH = os.path.join(FIXTURES, "proc", "thrash-20260917-175030-reconstructed")
PROCS = os.path.join(FIXTURES, "procs")
INCIDENTS = os.path.join(FIXTURES, "incidents")
LIVE_INCIDENTS = os.path.expanduser("~/load-incidents")

from loadguard import build  # noqa: E402
from loadguard.snapshot import parse_incident  # noqa: E402

HOME = "/home/getty"
SLICE_CGROUP = ("0::/user.slice/user-1000.slice/user@1000.service/app.slice/"
                "app-loadguard.slice/loadguard-00000000-9000.scope")
BIN = {}


def setUpModule():
    cc = build.find_cc()
    if cc is None:
        raise unittest.SkipTest("no C compiler (cc/gcc/$CC) on PATH")
    tmp = tempfile.mkdtemp(prefix="loadguard-throttle-")
    BIN["tmp"] = tmp
    for name, flags, defines in (
            ("hook", build.FLAGS + ("-Werror",), ()),
            ("driver", build.TEST_FLAGS, ("-DLOADGUARD_TEST",))):
        out = os.path.join(tmp, name)
        ok, output = build.compile_hook(ROOT, cc, out, flags, defines)
        if not ok:
            raise AssertionError("build of %s failed:\n%s" % (name, output))
        BIN[name] = out


def tearDownModule():
    if "tmp" in BIN:
        shutil.rmtree(BIN["tmp"], ignore_errors=True)


def payload(command):
    return json.dumps({"session_id": "s", "hook_event_name": "PreToolUse",
                       "tool_name": "Bash", "tool_input": {"command": command},
                       "tool_use_id": "toolu_x"}).encode("utf-8")


def base_env(**extra):
    """No LOADGUARD_* from the developer's shell leaks into a test."""
    env = {"PATH": os.environ["PATH"], "HOME": HOME}
    env.update(extra)
    return env


def run(argv, stdin=b"{}", env=None, timeout=30):
    return subprocess.run(argv, input=stdin, capture_output=True,
                          timeout=timeout,
                          env=base_env() if env is None else env)


# --- fixture trees ---------------------------------------------------------

def add_process(root, pid, ppid, comm, argv, cgroup, cwd):
    """One /proc/<pid> entry: stat, cmdline, cgroup, cwd (a symlink)."""
    d = os.path.join(root, "proc", str(pid))
    os.makedirs(d)
    with open(os.path.join(d, "stat"), "w", encoding="utf-8") as f:
        f.write("%d (%s) S %d %d %d 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 "
                "100 0 0\n" % (pid, comm, ppid, pid, pid))
    with open(os.path.join(d, "cmdline"), "wb") as f:
        f.write(b"".join(a.encode("utf-8") + b"\0" for a in argv))
    with open(os.path.join(d, "cgroup"), "w", encoding="utf-8") as f:
        f.write(cgroup + "\n")
    if cwd is not None:
        os.symlink(cwd, os.path.join(d, "cwd"))
    return d


def add_scenario(root, name):
    with open(os.path.join(PROCS, name + ".json"), encoding="utf-8") as f:
        for p in json.load(f)["processes"]:
            add_process(root, p["pid"], p["ppid"], p["comm"], p["argv"],
                        p["cgroup"], p["cwd"])


def add_prove(root, pid, cwd=HOME + "/dev/x"):
    """A confined `prove -lr t/` with its wrapper (pid - 1) and a child."""
    add_process(root, pid - 1, 4100, "bash",
                ["/bin/bash", "-c", "eval 'prove -lr t/' && pwd -P"],
                SLICE_CGROUP, cwd)
    add_process(root, pid, pid - 1, "prove",
                ["/usr/bin/perl", "/usr/bin/prove", "-lr", "t/"],
                SLICE_CGROUP, cwd)
    add_process(root, pid + 1, pid, "perl", ["/usr/bin/perl", "t/a.t"],
                SLICE_CGROUP, cwd)


class Tree(unittest.TestCase):
    def tree(self, pressure=None, scenarios=()):
        """A temporary root: a pressure tree copied in, scenarios added."""
        d = tempfile.mkdtemp(prefix="loadguard-root-")
        self.addCleanup(shutil.rmtree, d, True)
        root = os.path.join(d, "root")
        if pressure is None:
            os.makedirs(os.path.join(root, "proc"))
        else:
            shutil.copytree(pressure, root, symlinks=True)
        for name in scenarios:
            add_scenario(root, name)
        return root

    def write(self, root, rel, text):
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def set_psi_full(self, root, avg10):
        self.write(root, "proc/pressure/memory",
                   "some avg10=%.2f avg60=0.00 avg300=0.00 total=1\n"
                   "full avg10=%.2f avg60=0.00 avg300=0.00 total=1\n"
                   % (avg10, avg10))

    def set_swap_used(self, root, percent):
        total = 11598972
        used = -(-total * percent // 100)   # rounded up: the hook floors
        self.write(root, "proc/meminfo",
                   "MemTotal:        8025928 kB\n"
                   "MemAvailable:    2469728 kB\n"
                   "SwapTotal:      %9d kB\n"
                   "SwapFree:       %9d kB\n"
                   % (total, total - used))

    def driver(self, mode, root=None, stdin=b"{}", **env):
        argv = [BIN["driver"], mode] + ([root] if root is not None else [])
        return run(argv, stdin, base_env(**env))

    def decide(self, root, command, **env):
        proc = self.driver("decide", root, payload(command), **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, b"")
        return proc.stdout

    def reason(self, root, command, **env):
        """The deny reason; fails unless the output is exactly the deny."""
        out = self.decide(root, command, **env)
        self.assertTrue(out.startswith(b"{") and out.endswith(b"}"), out)
        doc = json.loads(out.decode("utf-8"))
        hso = doc.pop("hookSpecificOutput")
        self.assertEqual(doc, {})
        reason = hso.pop("permissionDecisionReason")
        self.assertEqual(hso, {"hookEventName": "PreToolUse",
                               "permissionDecision": "deny"})
        self.assertIsInstance(reason, str)
        self.assertTrue(reason.startswith("loadguard: heavy command refused"),
                        reason)
        self.assertEqual(reason.count("\n"), 1, reason)  # two lines
        return reason

    def assert_allowed(self, root, command, **env):
        self.assertEqual(self.decide(root, command, **env), b"")


# --- the matcher -------------------------------------------------------------

HEAVY = {
    "prove -lr t/": "prove",
    "prove": "prove",
    "/usr/bin/prove -l t/foo.t": "prove",
    "perl /usr/bin/prove -lr t": "prove",
    "cd ~/dev/x && prove -lr t/": "prove",
    "git pull; prove -lr t/": "prove",
    "ls || prove": "prove",
    "echo start\nprove -lr t/": "prove",
    "FOO=1 BAR=2 prove -l t/a.t": "prove",
    "env -i PATH=/usr/bin prove": "prove",
    "nice -n 10 make test": "make test",
    "ionice -c3 nice prove": "prove",
    "timeout 10m cargo test": "cargo test",
    "nohup prove -lr t &": "prove",
    "time prove": "prove",
    "xargs -P4 prove": "prove",
    "( cd x && prove )": "prove",
    "echo $(prove -l t/x.t)": "prove",
    "echo `make test`": "make test",
    "prove -lr t 2>&1 | tee log": "prove",
    "if make test; then echo ok; fi": "make test",
    "for f in t/*.t; do prove -l $f; done": "prove",
    "! make test": "make test",
    "{ prove; }": "prove",
    "'prove' -l t": "prove",
    "make -j4 test": "make test",
    "make TEST_VERBOSE=1 test": "make test",
    "perl Makefile.PL && make && make test": "make test",
    "dzil test": "dzil test",
    "dzil release": "dzil release",
    "dzil build": "dzil build",
    "cpanm --installdeps .": "cpanm",
    "docker build -t x .": "docker build",
    "podman run --rm -it x": "podman run",
    "podman --remote run x": "podman run",
    "cargo build --release": "cargo build",
    "cargo +nightly test": "cargo test",
    "npm test": "npm test",
    "perlbench": "perlbench",
    "~/bin/perlbench --all": "perlbench",
    "claude -p 'fix the tests'": "claude -p",
    "claude --print hi": "claude --print",
    "claude --bg 'refactor'": "claude --bg",
    "cat > x.sh <<-EOF\n\tprove\n\tEOF\nmake test": "make test",
    "cat <<A <<B\nprove\nA\nprove\nB\ncpanm X": "cpanm",
    "echo hi \\\n; prove": "prove",
}

LIGHT = [
    "", "   ", "pwd", "ls -la", "git status", "karr show 4", "loadguard status",
    "git log --grep=prove", "grep -rn 'make test' .", "cat prove.txt",
    "echo prove", "which prove", "command -v prove", "type prove",
    "man prove", "ls ~/dev/prove",
    "echo 'a; prove'", 'git commit -m "fix; make test"',
    "git commit -m 'run prove\nand make test'",
    "cat > x.sh <<'EOF'\nprove -lr t\nmake test\nEOF\necho done",
    "python3 - <<'EOF'\nimport os\nEOF",
    "cat <<EOF",          # the text ends inside the heredoc body
    "cat <<EOF\nprove",
    "ls # ; prove", "echo a#b; ls",
    "make", "make install", "make -C lib", "dzil listdeps", "dzil authordeps",
    "docker ps", "podman images", "podman logs x", "cargo check",
    "npm install", "npm run lint", "claude --version", "claude mcp list",
    "perl -Ilib t/foo.t", "perl -e 'print 1'", "bash ./run.sh",
    "bash -c 'prove -lr t'",     # inline code is not looked into
    "sudo prove", "echo x > prove", "cat < prove", "cat <<< prove",
    "nice", "env", "FOO=1",
]


class Matcher(Tree):
    def label(self, command):
        proc = self.driver("heavy", stdin=payload(command))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.decode("utf-8")

    def test_heavy(self):
        for command, label in HEAVY.items():
            with self.subTest(command=command):
                self.assertEqual(self.label(command), label)

    def test_light(self):
        for command in LIGHT:
            with self.subTest(command=command):
                self.assertEqual(self.label(command), "")

    def test_long_and_odd_commands(self):
        cases = {
            "x" * 100000 + "; prove": "prove",      # a word past WORD_MAX
            " ".join(["a"] * 100) + "; make test": "make test",
            "make " + "V=1 " * 40 + "test": "",     # test past MAX_WORDS
            "prove; \x01 ä \U0001F600": "prove",
            "\x01prove": "",
            "'unterminated; prove": "",
            '"unterminated; prove': "",
            "\\": "", "<<": "", "<<-": "", "&": "", "'": "",
        }
        for command, label in cases.items():
            with self.subTest(command=command[:40]):
                self.assertEqual(self.label(command), label)


# --- measurement ------------------------------------------------------------

class Measure(Tree):
    def measure(self, root):
        proc = self.driver("measure", root)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.decode()

    def test_recorded_calm(self):
        # SwapFree 4565948 of 11598972 kB: 60.6 % used; zram0 97.9 % full.
        self.assertEqual(self.measure(CALM), "full=0.00 swap=60 zram=97")

    def test_reconstructed_thrash(self):
        self.assertEqual(self.measure(THRASH), "full=59.94 swap=100 zram=-1")

    def test_missing_sources(self):
        self.assertEqual(self.measure(self.tree()),
                         "full=-1.00 swap=-1 zram=-1")
        self.assertEqual(self.measure("/nonexistent/loadguard-root"),
                         "full=-1.00 swap=-1 zram=-1")

    def test_garbage_sources(self):
        root = self.tree(CALM)
        for rel in ("proc/pressure/memory", "proc/meminfo",
                    "sys/block/zram0/disksize"):
            self.write(root, rel, "garbage\n")
        self.assertEqual(self.measure(root), "full=-1.00 swap=-1 zram=-1")
        self.write(root, "proc/pressure/memory",
                   "some avg10=1 avg60=0 avg300=0 total=0\n"
                   "full avg10=-3 avg60=0 avg300=0 total=0\n")
        self.write(root, "proc/meminfo",
                   "SwapTotal: -5 kB\nSwapFree: 1 kB\n")
        self.assertEqual(self.measure(root), "full=-1.00 swap=-1 zram=-1")

    def test_no_swap(self):
        root = self.tree(CALM)
        self.write(root, "proc/meminfo",
                   "MemTotal: 8025928 kB\nSwapTotal:  0 kB\nSwapFree:  0 kB\n")
        self.assertIn("swap=-1", self.measure(root))

    def test_psi_without_full_line(self):
        root = self.tree(CALM)
        self.write(root, "proc/pressure/memory",
                   "some avg10=80.00 avg60=0 avg300=0 total=1\n")
        self.assertIn("full=-1.00", self.measure(root))


# --- slots --------------------------------------------------------------------

class Slots(Tree):
    def slots(self, root, **env):
        proc = self.driver("slots", root, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.decode("utf-8").splitlines()
        return int(lines[0]), lines[1:]

    def test_idle_sessions_hold_nothing(self):
        # Light commands, plain `make`, MCP servers, and heavy processes
        # outside app-loadguard.slice (a tmux prove, a terminal make test).
        self.assertEqual(self.slots(self.tree(CALM, ["idle-sessions"])),
                         (0, []))

    def test_prove_chain_is_one_slot(self):
        # bash wrapper (its code string mentions prove) + perl running
        # prove + two perl test children: one running command, one slot.
        root = self.tree(CALM, ["idle-sessions", "prove-chain"])
        self.assertEqual(self.slots(root),
                         (1, ["prove -lr t/ in ~/dev/sunriser"]))

    def test_make_recursion_is_one_slot(self):
        root = self.tree(CALM, ["idle-sessions", "make-recursion"])
        self.assertEqual(self.slots(root),
                         (1, ["make test in ~/dev/p5-foo"]))

    def test_claude_p_holds_no_slot(self):
        root = self.tree(CALM, ["idle-sessions", "claude-p"])
        self.assertEqual(self.slots(root), (0, []))

    def test_what_claude_p_runs_holds_one(self):
        root = self.tree(CALM, ["idle-sessions", "claude-p", "claude-p-prove"])
        self.assertEqual(self.slots(root),
                         (1, ["prove -l t/foo.t in ~/dev/sunriser"]))

    def test_npm_process_title(self):
        # npm rewrites its cmdline to "npm test"; the prove it starts has
        # npm test above it and holds no slot of its own.
        root = self.tree(CALM, ["idle-sessions", "npm-title"])
        self.assertEqual(self.slots(root), (1, ["npm test in ~/dev/p5-foo"]))

    def test_everything_at_once(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion", "claude-p",
                                "claude-p-prove", "npm-title"])
        busy, shown = self.slots(root)
        self.assertEqual(busy, 4)
        self.assertEqual(shown, ["prove -lr t/ in ~/dev/sunriser",
                                 "prove -l t/foo.t in ~/dev/sunriser",
                                 "make test in ~/dev/p5-foo"])

    def test_inline_code_is_no_script(self):
        # A shell or perl running inline code holds no slot itself, even if
        # the code's last path component is a heavy name — e.g. a wrapper
        # without the `pwd -P >| …-cwd` suffix Claude Code appends today.
        # What the code starts is judged on its own.
        root = self.tree(CALM)
        add_process(root, 8001, 4100, "bash",
                    ["/bin/bash", "-c", "eval 'ls /usr/bin/prove'"],
                    SLICE_CGROUP, HOME)
        add_process(root, 8002, 4100, "sh", ["sh", "-c", "/usr/bin/prove"],
                    SLICE_CGROUP, HOME)
        add_process(root, 8003, 4100, "perl", ["perl", "-e", "prove"],
                    SLICE_CGROUP, HOME)
        self.assertEqual(self.slots(root), (0, []))

    def test_heavy_outside_the_slice_never_counts(self):
        root = self.tree(CALM)
        add_process(root, 7000, 1, "prove",
                    ["/usr/bin/perl", "/usr/bin/prove", "-lr", "t"],
                    "0::/user.slice/user-1000.slice/session-3.scope", HOME)
        add_process(root, 7001, 1, "make", ["make", "test"],
                    "0::/user.slice/user-1000.slice/user@1000.service/"
                    "app.slice/app-loadguard-other.slice/x.scope", HOME)
        self.assertEqual(self.slots(root), (0, []))

    def test_unreadable_pieces_are_skipped(self):
        root = self.tree(CALM)
        add_prove(root, 8001)
        # A heavy process without stat, one without cgroup, one without
        # cmdline, one gone between readdir and read: none counts.
        for pid, missing in ((8100, "stat"), (8200, "cgroup"),
                             (8300, "cmdline")):
            d = add_process(root, pid, 1, "prove",
                            ["/usr/bin/prove"], SLICE_CGROUP, HOME)
            os.unlink(os.path.join(d, missing))
        os.makedirs(os.path.join(root, "proc", "8400"))
        # Non-numeric entries of /proc are not processes.
        for name in ("self", "8500x", "-1", "0", "99999999999"):
            add_process(root, 1, 1, "x", ["/usr/bin/prove"], SLICE_CGROUP,
                        HOME)
            os.rename(os.path.join(root, "proc", "1"),
                      os.path.join(root, "proc", name))
        self.assertEqual(self.slots(root),
                         (1, ["prove -lr t/ in ~/dev/x"]))

    @unittest.skipIf(os.geteuid() == 0, "root reads files with mode 000")
    def test_unreadable_files_are_skipped(self):
        root = self.tree(CALM)
        add_prove(root, 8001)
        d = add_process(root, 8100, 1, "prove", ["/usr/bin/prove"],
                        SLICE_CGROUP, HOME)
        os.chmod(os.path.join(d, "cmdline"), 0)
        self.assertEqual(self.slots(root)[0], 1)

    def test_odd_comm_empty_cmdline_kernel_thread(self):
        root = self.tree(CALM)
        add_process(root, 8001, 1, "a) (b) S 99", ["make", "test"],
                    SLICE_CGROUP, HOME + "/w")
        add_process(root, 8002, 8001, "perl", [], SLICE_CGROUP, None)
        add_process(root, 2, 0, "kthreadd", [], "0::/", None)
        self.assertEqual(self.slots(root), (1, ["make test in ~/w"]))

    def test_cwd(self):
        root = self.tree(CALM)
        add_process(root, 8001, 1, "prove", ["/usr/bin/prove"], SLICE_CGROUP,
                    None)
        add_process(root, 8002, 1, "prove", ["/usr/bin/prove", "-l"],
                    SLICE_CGROUP, HOME)
        add_process(root, 8003, 1, "prove", ["/usr/bin/prove", "-r"],
                    SLICE_CGROUP, HOME + "x/y")
        self.assertEqual(self.slots(root)[1],
                         ["prove", "prove -l in ~", "prove -r in /home/gettyx/y"])
        env = base_env()
        del env["HOME"]
        proc = run([BIN["driver"], "slots", root], env=env)
        self.assertEqual(proc.stdout.decode().splitlines()[2],
                         "prove -l in /home/getty")

    def test_labels_are_short_and_clean(self):
        root = self.tree(CALM)
        add_process(root, 8001, 1, "prove",
                    ["/usr/bin/perl", "/usr/bin/prove", "-lr"] +
                    ["t/very/long/path/%02d.t" % i for i in range(20)],
                    SLICE_CGROUP, HOME + "/dev/" + "d" * 300)
        add_process(root, 8002, 1, "prove", ["prove", "a\tb\x1bc"],
                    SLICE_CGROUP, None)
        os.symlink(b"/tmp/\xff\xfe-dir",
                   os.path.join(root.encode(), b"proc", b"8002", b"cwd"))
        busy, shown = self.slots(root)
        self.assertEqual(busy, 2)
        self.assertTrue(shown[0].startswith("prove -lr t/very/long/path/00.t"))
        self.assertIn(" ... in ~/dev/ddd", shown[0])
        self.assertTrue(shown[0].endswith("..."))
        self.assertLess(len(shown[0]), 160)
        self.assertEqual(shown[1], "prove a?b?c in /tmp/??-dir")


# --- the decision ---------------------------------------------------------

class Decide(Tree):
    def test_light_never_denied_under_thrash(self):
        root = self.tree(THRASH, ["idle-sessions", "prove-chain",
                                  "make-recursion"])
        for command in LIGHT + ["git status", "karr show 4", "ls", "cat x"]:
            with self.subTest(command=command):
                self.assert_allowed(root, command, LOADGUARD_HEAVY_SLOTS="1")

    def test_heavy_allowed_when_calm(self):
        # The recorded reuben state (memory calm, cpu some 86 %).
        root = self.tree(CALM, ["idle-sessions"])
        for command in HEAVY:
            with self.subTest(command=command):
                self.assert_allowed(root, command)

    def test_heavy_denied_under_thrash(self):
        reason = self.reason(self.tree(THRASH), "cd ~/dev/x && prove -lr t/")
        self.assertEqual(
            reason,
            "loadguard: heavy command refused (prove): memory pressure "
            "full=59.9% (limit 10%), swap 100% used (limit 90%).\n"
            "Wait and retry later; light commands (git status, ls, cat) "
            "still run. Or run fewer tests at once: `prove -l t/foo.t` "
            "instead of `-r`.")

    def test_thrash_reason_per_kind(self):
        root = self.tree(THRASH)
        self.write(root, "sys/block/zram0/disksize", "3287420928\n")
        self.write(root, "sys/block/zram0/mm_stat", "3218501632 1 2 0\n")
        for command, parts in {
                "make test": ("(make test)", "zram 97% full",
                              "single test file instead of the whole suite"),
                "claude -p 'go'": ("(claude -p)",
                                   "Do not start new `claude -p`"),
                "podman build .": ("(podman build)", "Wait and retry later"),
        }.items():
            with self.subTest(command=command):
                reason = self.reason(root, command)
                for part in parts:
                    self.assertIn(part, reason)
                self.assertNotIn("slots", reason)

    def test_heavy_denied_when_slots_full(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion"])
        reason = self.reason(root, "dzil test", LOADGUARD_HEAVY_SLOTS="2")
        self.assertEqual(
            reason,
            "loadguard: heavy command refused (dzil test): 2/2 heavy slots "
            "busy (prove -lr t/ in ~/dev/sunriser; make test in "
            "~/dev/p5-foo), memory pressure full=0.0% (limit 10%), swap 60% "
            "used (limit 90%), zram 97% full.\n"
            "Wait for one to finish, then retry; light commands (git status, "
            "ls, cat) still run. Or run a single test file instead of the "
            "whole suite.")
        self.assert_allowed(root, "dzil test", LOADGUARD_HEAVY_SLOTS="3")

    def test_more_holders_than_shown(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion", "claude-p",
                                "claude-p-prove", "npm-title"])
        reason = self.reason(root, "cpanm Foo", LOADGUARD_HEAVY_SLOTS="4")
        self.assertIn("4/4 heavy slots busy (", reason)
        self.assertIn("make test in ~/dev/p5-foo; +1 more)", reason)

    def test_claude_p_running_leaves_the_slot_free(self):
        root = self.tree(CALM, ["idle-sessions", "claude-p"])
        self.assert_allowed(root, "prove -lr t/", LOADGUARD_HEAVY_SLOTS="1")

    def test_one_command_is_one_slot(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain"])
        self.assert_allowed(root, "make test", LOADGUARD_HEAVY_SLOTS="2")
        self.reason(root, "make test", LOADGUARD_HEAVY_SLOTS="1")

    def test_default_slots_is_half_the_cpus(self):
        n = max(1, len(os.sched_getaffinity(0)) // 2)
        root = self.tree(CALM)
        for i in range(n - 1):
            add_prove(root, 20000 + 10 * i)
        self.assert_allowed(root, "make test")
        add_prove(root, 30000)
        self.assertIn("%d/%d heavy slots busy" % (n, n),
                      self.reason(root, "make test"))

    def test_kill_switch(self):
        root = self.tree(THRASH, ["idle-sessions", "prove-chain"])
        self.assert_allowed(root, "prove -lr t/", LOADGUARD_THROTTLE="0",
                            LOADGUARD_HEAVY_SLOTS="1")
        # Only the exact value 0 turns it off.
        for value in ("", "00", "no", "false", "off", " 0", "0 "):
            with self.subTest(value=value):
                self.reason(root, "prove -lr t/", LOADGUARD_THROTTLE=value)

    def test_psi_limit_from_env(self):
        root = self.tree(CALM)
        self.set_psi_full(root, 15)
        self.assertIn("full=15.0% (limit 10%)", self.reason(root, "prove"))
        self.assert_allowed(root, "prove", LOADGUARD_PSI_FULL="20")
        self.assert_allowed(root, "prove", LOADGUARD_PSI_FULL="20%")
        self.assertIn("full=15.0% (limit 15%)",
                      self.reason(root, "prove", LOADGUARD_PSI_FULL="15"))
        self.set_psi_full(root, 9.99)
        self.assert_allowed(root, "prove")

    def test_swap_limit_from_env(self):
        root = self.tree(CALM)
        self.set_swap_used(root, 95)
        self.assertIn("swap 95% used (limit 90%)", self.reason(root, "prove"))
        self.assert_allowed(root, "prove", LOADGUARD_SWAP_USED="96")
        self.set_swap_used(root, 89)
        self.assert_allowed(root, "prove")

    def test_slots_from_env(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain"])
        self.assertIn("1/1 heavy slots busy",
                      self.reason(root, "prove", LOADGUARD_HEAVY_SLOTS="1"))
        self.assert_allowed(root, "prove", LOADGUARD_HEAVY_SLOTS="2")

    def test_invalid_env_values_keep_the_defaults(self):
        root = self.tree(CALM)
        self.set_psi_full(root, 15)
        for value in ("", "abc", "0", "101", "-5", "10.5", " 20", "20 ",
                      "99999999999999999999", "20%%"):
            with self.subTest(value=value):
                self.assertIn("(limit 10%)", self.reason(
                    root, "prove", LOADGUARD_PSI_FULL=value,
                    LOADGUARD_SWAP_USED=value, LOADGUARD_HEAVY_SLOTS=value))

    def test_fail_open_without_measurements(self):
        # No /proc, no PSI, no meminfo, garbage: no signal is no objection.
        for root in (self.tree(), "/nonexistent/loadguard-root"):
            with self.subTest(root=root):
                self.assert_allowed(root, "prove -lr t/")
        root = self.tree(CALM)
        for rel in ("proc/pressure/memory", "proc/meminfo"):
            self.write(root, rel, "garbage\n")
        self.assert_allowed(root, "prove -lr t/")

    @unittest.skipIf(os.geteuid() == 0, "root reads files with mode 000")
    def test_fail_open_on_unreadable_measurements(self):
        root = self.tree(THRASH)
        for rel in ("proc/pressure/memory", "proc/meminfo"):
            os.chmod(os.path.join(root, rel), 0)
        self.assert_allowed(root, "prove -lr t/")

    def test_pressure_path_reads_no_process(self):
        # Under pressure the hook must not touch other processes: reading
        # their cmdline can fault swapped pages in and outlast the hook
        # timeout. A FIFO as cmdline blocks any reader: the decision still
        # returns at once.
        root = self.tree(THRASH, ["idle-sessions", "prove-chain"])
        os.unlink(os.path.join(root, "proc", "4201", "cmdline"))
        os.mkfifo(os.path.join(root, "proc", "4201", "cmdline"))
        start = time.monotonic()
        self.reason(root, "prove -lr t/")
        self.assertLess(time.monotonic() - start, 5)

    def test_light_path_reads_nothing(self):
        # Every source a FIFO: a light command must not open any of them.
        root = self.tree(CALM)
        for rel in ("proc/pressure/memory", "proc/meminfo"):
            os.unlink(os.path.join(root, rel))
            os.mkfifo(os.path.join(root, rel))
        for command in ("git status", "ls -la", "cat prove.txt"):
            with self.subTest(command=command):
                self.assert_allowed(root, command)

    def test_not_a_bash_payload(self):
        root = self.tree(THRASH)
        for stdin in (b"{}", b"", b"nul", json.dumps(
                {"tool_name": "Read", "tool_input": {"command": "prove"}}
        ).encode()):
            with self.subTest(stdin=stdin):
                proc = self.driver("decide", root, stdin)
                self.assertEqual((proc.returncode, proc.stdout), (0, b""))


# --- calibration against the incident snapshots ---------------------------

def incident_files():
    names = [os.path.join(INCIDENTS, n) for n in sorted(os.listdir(INCIDENTS))]
    if os.path.isdir(LIVE_INCIDENTS):
        names += [os.path.join(LIVE_INCIDENTS, n)
                  for n in sorted(os.listdir(LIVE_INCIDENTS))
                  if n.endswith(".txt")]
    return names


class Calibration(Tree):
    """Every snapshot, rebuilt as a /proc tree: thrash denies, calm does not.

    ~/load-incidents (54 snapshots) is read, never copied; the three excerpts
    in t/fixtures/incidents/ keep the test meaningful without it.
    """

    def root_for(self, snap):
        root = self.tree()
        psi = snap.psi_memory
        self.write(root, "proc/pressure/memory", "".join(
            "%s avg10=%.2f avg60=%.2f avg300=%.2f total=%d\n"
            % (kind, line.avg10, line.avg60, line.avg300, line.total)
            for kind, line in (("some", psi.some), ("full", psi.full))))
        self.write(root, "proc/meminfo", "".join(
            "%s: %d kB\n" % (key, value // 1024) for key, value in (
                ("MemTotal", snap.mem_total),
                ("MemAvailable", snap.mem_available),
                ("SwapTotal", snap.swap_total),
                ("SwapFree", snap.swap_free))))
        return root

    def test_every_snapshot(self):
        calm = thrash = 0
        for path in incident_files():
            with open(path, errors="replace") as f:
                snap = parse_incident(f.read())
            full = snap.psi_memory.full.avg10
            with self.subTest(incident=os.path.basename(path), full=full):
                # The gap the defaults sit in: nothing between 2.03 and 45.47.
                self.assertTrue(full <= 2.03 or full >= 45.47, full)
                root = self.root_for(snap)
                if full >= 45.47:
                    thrash += 1
                    self.reason(root, "prove -lr t/")
                else:
                    calm += 1
                    self.assert_allowed(root, "prove -lr t/")
        self.assertGreaterEqual(calm, 2)
        self.assertGreaterEqual(thrash, 1)
        if os.path.isdir(LIVE_INCIDENTS):
            sys.stderr.write("[calibration: %d calm allowed, %d thrash "
                             "denied] " % (calm, thrash))


# --- the production binary on the live host (read-only) -------------------

class LiveHost(unittest.TestCase):
    @unittest.skipUnless(os.path.isdir("/proc/self"), "no /proc on this host")
    def test_heavy_path_runtime(self):
        # The heavy path reads PSI and meminfo and, when calm, scans every
        # /proc entry. Target < 30 ms, like the light path. Whatever the
        # host's state, the answer is silence or one well-formed deny.
        stdin = payload("prove -lr t/")
        times, outs = [], set()
        for _ in range(100):
            start = time.perf_counter()
            proc = run([BIN["hook"]], stdin)
            times.append((time.perf_counter() - start) * 1000)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            outs.add(proc.stdout)
        for out in outs:
            if out:
                doc = json.loads(out)
                self.assertEqual(
                    doc["hookSpecificOutput"]["permissionDecision"], "deny")
        times.sort()
        median, p90 = statistics.median(times), times[int(len(times) * 0.9)]
        sys.stderr.write("[heavy path n=100, %d processes: median %.2f ms, "
                         "p90 %.2f ms] " % (
                             len([p for p in os.listdir("/proc")
                                  if p.isdigit()]), median, p90))
        self.assertLess(median, 30)

    def test_light_path_ignores_proc(self):
        # Same binary, light command: nothing on stdout, whatever the host.
        proc = run([BIN["hook"]], payload("git status"))
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (0, b"", b""))


if __name__ == "__main__":
    unittest.main()
