"""Stage 2+3 (k4): the hook denies heavy commands under memory pressure or
when every heavy slot is busy, and tells the model why. Stage 4 (k6): under
memory pressure, UserPromptSubmit and SessionStart get one line of context;
otherwise the hook prints nothing.

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
EVENTS = os.path.join(FIXTURES, "events")
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


EVENT_FIXTURES = {"UserPromptSubmit": "user-prompt-submit.json",
                  "SessionStart": "session-start.json"}


def event_payload(event, **fields):
    """A context event's payload (t/fixtures/events/), fields replaced."""
    with open(os.path.join(EVENTS, EVENT_FIXTURES[event]), "rb") as f:
        doc = json.load(f)
    doc.update(fields)
    return json.dumps(doc).encode("utf-8")


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
            "still run.")

    def test_thrash_reason_per_kind(self):
        root = self.tree(THRASH)
        self.write(root, "sys/block/zram0/disksize", "3287420928\n")
        self.write(root, "sys/block/zram0/mm_stat", "3218501632 1 2 0\n")
        for command, parts in {
                "make test": ("(make test)", "zram 97% full",
                              "Wait and retry later"),
                "claude -p 'go'": ("(claude -p)",
                                   "Do not start new `claude -p`"),
                "podman build .": ("(podman build)", "Wait and retry later"),
        }.items():
            with self.subTest(command=command):
                reason = self.reason(root, command)
                for part in parts:
                    self.assertIn(part, reason)
                self.assertNotIn("slots", reason)

    def test_no_test_run_advised_under_pressure(self):
        # Any test run adds memory, and one perl can take the box (the
        # 3.8 GB one-liner, 20260917-175030): under pressure the advice is
        # to wait, never a smaller run — nor a way past the classifier.
        root = self.tree(THRASH)
        for command in HEAVY:
            with self.subTest(command=command):
                reason = self.reason(root, command)
                self.assertIn("\nWait and retry later; light commands "
                              "(git status, ls, cat) still run.", reason)
                for advice in ("prove -l", "test file", "fewer tests",
                               "perl", "When you retry"):
                    self.assertNotIn(advice, reason.split("\n")[1])

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
            "ls, cat) still run. When you retry, run a single test file "
            "instead of the whole suite.")
        self.assert_allowed(root, "dzil test", LOADGUARD_HEAVY_SLOTS="3")
        # A smaller run still needs a slot: advice for the retry, not a way
        # around the wait.
        self.assertTrue(self.reason(root, "prove -lr t/",
                                    LOADGUARD_HEAVY_SLOTS="2").endswith(
            "\nWait for one to finish, then retry; light commands (git "
            "status, ls, cat) still run. When you retry, run fewer tests: "
            "`prove -l t/foo.t` instead of `-r`."))
        self.assertTrue(self.reason(root, "podman build .",
                                    LOADGUARD_HEAVY_SLOTS="2").endswith(
            "then retry; light commands (git status, ls, cat) still run."))

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


# --- the report modes for bin/loadguard (k5) ---------------------------------

def default_slots():
    return max(1, len(os.sched_getaffinity(0)) // 2)


class Report(Tree):
    """`report ROOT` / `explain ROOT` print what --report / --explain print."""

    def report(self, root, mode="report", stdin=b"{}", **env):
        proc = self.driver(mode, root, stdin, **env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, b"")
        out = proc.stdout.decode("utf-8")
        self.assertEqual(out.count("\n"), 1, out)     # one line
        self.assertTrue(out.endswith("}\n"), out)
        return json.loads(out)

    def explain(self, root, command, **env):
        return self.report(root, "explain", payload(command), **env)

    def test_status_calm(self):
        root = self.tree(CALM, ["idle-sessions"])
        self.assertEqual(self.report(root, LOADGUARD_HEAVY_SLOTS="2"), {
            "report": 1, "mode": "status", "throttle": True, "ignored": [],
            "limits": {"psi_full": 10, "swap_used": 90, "slots": 2},
            "pressure": {"full": 0, "some": 0.31, "swap": 60, "zram": 97},
            "pressured": False, "slots": {"busy": 0, "holders": []},
            "refuse_heavy": False})

    def test_status_under_pressure_scans_nothing(self):
        # As in the hook: a FIFO as cmdline would block any reader.
        root = self.tree(THRASH, ["idle-sessions", "prove-chain"])
        os.unlink(os.path.join(root, "proc", "4201", "cmdline"))
        os.mkfifo(os.path.join(root, "proc", "4201", "cmdline"))
        start = time.monotonic()
        doc = self.report(root)
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(doc["pressure"], {"full": 59.94, "some": 63.49,
                                           "swap": 100, "zram": None})
        self.assertEqual(doc["limits"]["slots"], default_slots())
        self.assertEqual((doc["pressured"], doc["slots"], doc["refuse_heavy"]),
                         (True, None, True))

    def test_status_slots_full(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion", "claude-p",
                                "claude-p-prove", "npm-title"])
        doc = self.report(root, LOADGUARD_HEAVY_SLOTS="4")
        self.assertEqual(doc["slots"], {"busy": 4, "holders": [
            "prove -lr t/ in ~/dev/sunriser",
            "prove -l t/foo.t in ~/dev/sunriser",
            "make test in ~/dev/p5-foo"]})
        self.assertEqual((doc["pressured"], doc["refuse_heavy"]),
                         (False, True))
        self.assertFalse(self.report(root, LOADGUARD_HEAVY_SLOTS="5")
                         ["refuse_heavy"])

    def test_status_throttle_off_still_measures(self):
        doc = self.report(self.tree(THRASH), LOADGUARD_THROTTLE="0")
        self.assertEqual((doc["throttle"], doc["pressured"],
                          doc["refuse_heavy"], doc["ignored"]),
                         (False, True, False, []))

    def test_ignored_variables(self):
        root = self.tree(CALM)
        doc = self.report(root, LOADGUARD_THROTTLE="off",
                          LOADGUARD_PSI_FULL="5.5", LOADGUARD_SWAP_USED="",
                          LOADGUARD_HEAVY_SLOTS="0")
        self.assertEqual(doc["ignored"], [
            "LOADGUARD_THROTTLE", "LOADGUARD_PSI_FULL", "LOADGUARD_SWAP_USED",
            "LOADGUARD_HEAVY_SLOTS"])
        self.assertEqual(doc["limits"], {"psi_full": 10, "swap_used": 90,
                                         "slots": default_slots()})
        doc = self.report(root, LOADGUARD_PSI_FULL="20%",
                          LOADGUARD_HEAVY_SLOTS="4096")
        self.assertEqual((doc["ignored"], doc["limits"]["psi_full"],
                          doc["limits"]["slots"]), ([], 20, 4096))
        self.assertEqual(self.explain(root, "ls", LOADGUARD_SWAP_USED="x")
                         ["ignored"], ["LOADGUARD_SWAP_USED"])

    def test_explain_light_reads_nothing(self):
        root = self.tree(CALM)
        for rel in ("proc/pressure/memory", "proc/meminfo"):
            os.unlink(os.path.join(root, rel))
            os.mkfifo(os.path.join(root, rel))
        self.assertEqual(self.explain(root, "cat prove.txt"), {
            "report": 1, "mode": "explain", "throttle": True, "ignored": [],
            "bash": True, "heavy": None, "decision": "allow",
            "reason": None})

    def test_explain_heavy_allowed(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain"])
        doc = self.explain(root, "cd x && make test",
                           LOADGUARD_HEAVY_SLOTS="2")
        self.assertEqual(doc["heavy"], "make test")
        self.assertEqual(doc["limits"], {"psi_full": 10, "swap_used": 90,
                                         "slots": 2})
        self.assertEqual(doc["slots"], {
            "busy": 1, "holders": ["prove -lr t/ in ~/dev/sunriser"]})
        self.assertEqual((doc["pressured"], doc["decision"], doc["reason"]),
                         (False, "allow", None))

    def test_explain_under_pressure(self):
        doc = self.explain(self.tree(THRASH), "prove -lr t/")
        self.assertEqual(doc["limits"], {"psi_full": 10, "swap_used": 90})
        self.assertEqual((doc["pressured"], doc["slots"], doc["decision"]),
                         (True, None, "deny"))

    def test_explain_throttle_off(self):
        doc = self.explain(self.tree(THRASH), "prove", LOADGUARD_THROTTLE="0")
        self.assertEqual(doc, {
            "report": 1, "mode": "explain", "throttle": False, "ignored": [],
            "bash": True, "heavy": None, "decision": "allow",
            "reason": None})

    def test_explain_not_a_bash_payload(self):
        root = self.tree(THRASH)
        # A lone surrogate is what a non-UTF-8 command turns into in JSON.
        surrogate = (b'{"tool_name": "Bash", '
                     b'"tool_input": {"command": "prove \\udcff"}}')
        for stdin in (b"{}", b"", b"nul", surrogate, json.dumps(
                {"tool_name": "Read", "tool_input": {"command": "prove"}}
        ).encode()):
            with self.subTest(stdin=stdin):
                self.assertEqual(self.report(root, "explain", stdin), {
                    "report": 1, "mode": "explain", "throttle": True,
                    "ignored": [], "bash": False, "decision": "allow",
                    "reason": None})

    def test_explain_is_the_hook(self):
        # The decision logic exists once: for every root, environment and
        # command, --explain gives the verdict and the reason the hook
        # prints — byte for byte.
        roots = {
            "calm": self.tree(CALM, ["idle-sessions"]),
            "thrash": self.tree(THRASH, ["idle-sessions", "prove-chain"]),
            "busy": self.tree(CALM, ["idle-sessions", "prove-chain",
                                     "make-recursion", "claude-p",
                                     "claude-p-prove", "npm-title"]),
            "nothing": self.tree(),
        }
        envs = ({}, {"LOADGUARD_HEAVY_SLOTS": "1"},
                {"LOADGUARD_HEAVY_SLOTS": "4"}, {"LOADGUARD_THROTTLE": "0"},
                {"LOADGUARD_PSI_FULL": "1", "LOADGUARD_SWAP_USED": "50%"})
        commands = ("prove -lr t/", "cd x && FOO=1 nice make test",
                    "claude -p 'go'", "podman build .", "cpanm Foo",
                    "git status", "cat prove.txt", "echo 'a; prove'")
        seen = set()
        for name, root in roots.items():
            for env in envs:
                for command in commands:
                    with self.subTest(root=name, env=env, command=command):
                        out = self.decide(root, command, **env)
                        doc = self.explain(root, command, **env)
                        reason = json.loads(out)["hookSpecificOutput"][
                            "permissionDecisionReason"] if out else None
                        self.assertEqual(
                            (doc["decision"], doc["reason"]),
                            ("deny" if out else "allow", reason))
                        seen.add(doc["decision"] if reason is None else
                                 "slots" if "slots busy" in reason else
                                 "pressure")
        self.assertEqual(seen, {"allow", "slots", "pressure"})


# --- stage 4: the context line (k6) -----------------------------------------

CONTEXT_EVENTS = ("UserPromptSubmit", "SessionStart")
ADVICE = (". Heavy commands refused until it eases: prove, make test, "
          "builds, new claude -p/--bg. Light commands still run; see "
          "`loadguard status`.")
THRASH_LINE = ("loadguard: memory pressure full=59.9% (limit 10%), swap 100% "
               "used (limit 90%)" + ADVICE)


class Context(Tree):
    """`decide ROOT` with a UserPromptSubmit or SessionStart payload."""

    def emitted(self, root, event, stdin=None, **env):
        proc = self.driver("decide", root,
                           event_payload(event) if stdin is None else stdin,
                           **env)
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        return proc.stdout

    def line(self, root, event, **env):
        """The line; fails unless the output is exactly the documented form."""
        out = self.emitted(root, event, **env)
        self.assertTrue(out.startswith(b"{") and out.endswith(b"}"), out)
        self.assertNotIn(b"\n", out)
        doc = json.loads(out.decode("utf-8"))
        # Only hookSpecificOutput: Codex (k11) rejects unknown top-level keys.
        self.assertEqual(list(doc), ["hookSpecificOutput"])
        self.assertEqual(list(doc["hookSpecificOutput"]),
                         ["hookEventName", "additionalContext"])
        self.assertEqual(doc["hookSpecificOutput"]["hookEventName"], event)
        line = doc["hookSpecificOutput"]["additionalContext"]
        self.assertTrue(line.startswith("loadguard: memory pressure "), line)
        self.assertTrue(line.endswith(ADVICE), line)
        self.assertNotIn("\n", line)
        return line

    def assert_silent(self, root, **env):
        for event in CONTEXT_EVENTS:
            with self.subTest(event=event):
                self.assertEqual(self.emitted(root, event, **env), b"")

    def test_calm_says_nothing(self):
        # Zero context tokens: not a byte on stdout, whatever the prompt says.
        root = self.tree(CALM, ["idle-sessions", "prove-chain"])
        self.assert_silent(root)
        proc = self.driver("decide", root, event_payload(
            "UserPromptSubmit", prompt="run prove -lr t/ && make test"))
        self.assertEqual((proc.returncode, proc.stdout), (0, b""))

    def test_thrash_line(self):
        root = self.tree(THRASH)
        for event in CONTEXT_EVENTS:
            with self.subTest(event=event):
                self.assertEqual(self.line(root, event), THRASH_LINE)

    def test_line_stays_short(self):
        # The longest figures: 100.0 % against limits of 100 %.
        root = self.tree(CALM)
        self.set_psi_full(root, 100)
        self.set_swap_used(root, 100)
        line = self.line(root, "UserPromptSubmit", LOADGUARD_PSI_FULL="100",
                         LOADGUARD_SWAP_USED="100")
        self.assertIn("full=100.0% (limit 100%), swap 100% used (limit 100%)",
                      line)
        self.assertLessEqual(len(line), 216)

    def test_swap_alone(self):
        root = self.tree(CALM)
        self.set_swap_used(root, 95)
        self.assertEqual(
            self.line(root, "SessionStart"),
            "loadguard: memory pressure full=0.0% (limit 10%), swap 95% used "
            "(limit 90%)" + ADVICE)
        self.set_swap_used(root, 89)
        self.assert_silent(root)

    def test_psi_alone(self):
        root = self.tree(CALM)
        self.set_psi_full(root, 15)
        self.assertIn("full=15.0% (limit 10%), swap 60% used (limit 90%).",
                      self.line(root, "UserPromptSubmit"))
        self.set_psi_full(root, 9.99)
        self.assert_silent(root)

    def test_psi_unknown(self):
        root = self.tree(THRASH)
        os.unlink(os.path.join(root, "proc", "pressure", "memory"))
        self.assertEqual(
            self.line(root, "UserPromptSubmit"),
            "loadguard: memory pressure n/a, swap 100% used (limit 90%)"
            + ADVICE)

    def test_limits_from_env(self):
        root = self.tree(CALM)
        self.set_psi_full(root, 15)
        self.assert_silent(root, LOADGUARD_PSI_FULL="20")
        self.assertIn("(limit 15%)", self.line(root, "SessionStart",
                                               LOADGUARD_PSI_FULL="15%"))
        self.assertIn("(limit 10%)", self.line(root, "SessionStart",
                                               LOADGUARD_PSI_FULL="abc"))
        self.set_psi_full(root, 0)
        self.set_swap_used(root, 70)
        self.assertIn("swap 70% used (limit 50%)", self.line(
            root, "UserPromptSubmit", LOADGUARD_SWAP_USED="50"))

    def test_full_slots_alone_say_nothing(self):
        # Every slot busy, memory calm: a heavy command is refused, but the
        # host is fine and a slot frees in a moment — no line. The context
        # path reads no process: a FIFO as cmdline would block any reader.
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion", "claude-p",
                                "claude-p-prove", "npm-title"])
        self.assertIn("4/1 heavy slots busy",
                      self.reason(root, "make test", LOADGUARD_HEAVY_SLOTS="1"))
        os.unlink(os.path.join(root, "proc", "4201", "cmdline"))
        os.mkfifo(os.path.join(root, "proc", "4201", "cmdline"))
        start = time.monotonic()
        self.assert_silent(root, LOADGUARD_HEAVY_SLOTS="1")
        self.assertLess(time.monotonic() - start, 5)

    def test_pressure_path_reads_no_process(self):
        root = self.tree(THRASH, ["idle-sessions", "prove-chain"])
        os.unlink(os.path.join(root, "proc", "4201", "cmdline"))
        os.mkfifo(os.path.join(root, "proc", "4201", "cmdline"))
        start = time.monotonic()
        self.assertEqual(self.line(root, "UserPromptSubmit"), THRASH_LINE)
        self.assertLess(time.monotonic() - start, 5)

    def test_kill_switch(self):
        # LOADGUARD_THROTTLE=0 refuses nothing, so there is nothing to warn
        # about: the line would be false. Only the exact value 0.
        root = self.tree(THRASH)
        self.assert_silent(root, LOADGUARD_THROTTLE="0")
        for value in ("", "00", "no", "off", " 0"):
            with self.subTest(value=value):
                self.line(root, "SessionStart", LOADGUARD_THROTTLE=value)

    def test_fail_open_without_measurements(self):
        for root in (self.tree(), "/nonexistent/loadguard-root"):
            with self.subTest(root=root):
                self.assert_silent(root)
        root = self.tree(THRASH)
        for rel in ("proc/pressure/memory", "proc/meminfo"):
            self.write(root, rel, "garbage\n")
        self.assert_silent(root)

    def test_other_events_and_broken_payloads(self):
        # Under thrash: only a well-formed context event gets the line.
        root = self.tree(THRASH)
        good = event_payload("UserPromptSubmit")
        for stdin in (
                b"", b" ", b"{", good[:-1], good + b"x", b"\xff" + good,
                good.replace(b"factorial", b"fact\xfforial"),
                event_payload("UserPromptSubmit", hook_event_name=None),
                event_payload("UserPromptSubmit", hook_event_name=5),
                event_payload("UserPromptSubmit",
                              hook_event_name=["UserPromptSubmit"]),
                event_payload("UserPromptSubmit",
                              hook_event_name="userpromptsubmit"),
                event_payload("SessionStart", hook_event_name="SessionEnd"),
                event_payload("SessionStart", hook_event_name="SubagentStart"),
                event_payload("SessionStart", hook_event_name="PostToolUse"),
                b'"UserPromptSubmit"',
                b'[{"hook_event_name": "SessionStart"}]',
                json.dumps({"prompt": "x"}).encode()):
            with self.subTest(stdin=stdin[:60]):
                self.assertEqual(
                    self.emitted(root, "UserPromptSubmit", stdin), b"")

    def test_pre_tool_use_unchanged(self):
        # The event name picks the path; a Bash payload still gets the deny,
        # with or without hook_event_name, and never the context line.
        root = self.tree(THRASH)
        self.reason(root, "prove")
        bare = json.dumps({"tool_name": "Bash",
                           "tool_input": {"command": "prove"}}).encode()
        out = self.driver("decide", root, bare).stdout
        self.assertEqual(json.loads(out)["hookSpecificOutput"]
                         ["permissionDecision"], "deny")
        self.assert_allowed(root, "git status")

    def test_same_pressure_as_the_hook(self):
        # One test for pressure: the line shows exactly when --report says
        # pressured with throttle on, with the figures of the deny reason.
        roots = {
            "calm": self.tree(CALM, ["idle-sessions"]),
            "thrash": self.tree(THRASH),
            "busy": self.tree(CALM, ["idle-sessions", "prove-chain",
                                     "make-recursion"]),
            "nothing": self.tree(),
        }
        envs = ({}, {"LOADGUARD_HEAVY_SLOTS": "1"},
                {"LOADGUARD_THROTTLE": "0"},
                {"LOADGUARD_PSI_FULL": "1", "LOADGUARD_SWAP_USED": "50%"},
                {"LOADGUARD_PSI_FULL": "100", "LOADGUARD_SWAP_USED": "100"})
        seen = set()
        for name, root in roots.items():
            for env in envs:
                with self.subTest(root=name, env=env):
                    doc = json.loads(self.driver("report", root, **env).stdout)
                    shown = doc["throttle"] and doc["pressured"]
                    seen.add(shown)
                    if not shown:
                        self.assert_silent(root, **env)
                        continue
                    figures = self.line(root, "UserPromptSubmit", **env)[
                        len("loadguard: "):-len(ADVICE)]
                    reason = self.reason(root, "make test", **env)
                    head = ("loadguard: heavy command refused (make test): "
                            + figures)
                    self.assertTrue(reason.startswith(head) and
                                    reason[len(head)] in ".,", reason)
        self.assertEqual(seen, {True, False})


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
                # Stage 4 (k6): the context line exactly where pressure
                # alone refuses; a calm snapshot costs no context.
                line = self.driver("decide", root,
                                   event_payload("UserPromptSubmit")).stdout
                if full >= 45.47:
                    thrash += 1
                    self.reason(root, "prove -lr t/")
                    self.assertIn(b'"additionalContext":"loadguard: memory '
                                  b'pressure full=', line)
                else:
                    calm += 1
                    self.assert_allowed(root, "prove -lr t/")
                    self.assertEqual(line, b"")
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

    def test_report_modes(self):
        # --report reads no stdin: a pipe that stays open must not block it.
        r, w = os.pipe()
        try:
            times = []
            for _ in range(20):
                start = time.perf_counter()
                proc = subprocess.run([BIN["hook"], "--report"], stdin=r,
                                      capture_output=True, timeout=10,
                                      env=base_env())
                times.append((time.perf_counter() - start) * 1000)
                self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        finally:
            os.close(r)
            os.close(w)
        doc = json.loads(proc.stdout)
        self.assertEqual((doc["report"], doc["mode"]), (1, "status"))
        self.assertEqual(set(doc), {
            "report", "mode", "throttle", "ignored", "limits", "pressure",
            "pressured", "slots", "refuse_heavy"})
        sys.stderr.write("[--report n=20: median %.2f ms] "
                         % statistics.median(times))
        proc = run([BIN["hook"], "--explain"], payload("git status"))
        self.assertEqual(json.loads(proc.stdout)["heavy"], None)
        proc = run([BIN["hook"], "--explain"], payload("prove -lr t/"))
        doc = json.loads(proc.stdout)
        self.assertEqual(doc["heavy"], "prove")
        self.assertIn(doc["decision"], ("allow", "deny"))

    def assert_context_or_nothing(self, proc, event):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        if proc.stdout:
            self.assertNotIn(b"\n", proc.stdout)
            doc = json.loads(proc.stdout)
            hso = doc.pop("hookSpecificOutput")
            line = hso.pop("additionalContext")
            self.assertEqual((doc, hso), ({}, {"hookEventName": event}))
            self.assertTrue(line.startswith("loadguard: memory pressure "),
                            line)

    def test_context_events_exit_0(self):
        # Exit 2 on UserPromptSubmit would block the user's prompt and erase
        # it. Every path exits 0, straight or through the starter; stdout is
        # nothing or the one context object, whatever the host's state. The
        # low limits force the line wherever swap is in use — no load needed.
        data = tempfile.mkdtemp(prefix="loadguard-data-")
        self.addCleanup(shutil.rmtree, data, True)
        os.mkdir(os.path.join(data, "bin"))
        os.symlink(BIN["hook"], os.path.join(data, "bin", "loadguard-hook"))
        starter = os.path.join(ROOT, "hooks", "loadguard")
        good = event_payload("UserPromptSubmit")
        cases = [(e, event_payload(e)) for e in CONTEXT_EVENTS] + [
            ("UserPromptSubmit", stdin) for stdin in (
                b"", b"{", good[:-1], b"\xff" + good, b"[" * 5000 + b"]" * 5000,
                event_payload("UserPromptSubmit", hook_event_name=5),
                event_payload("UserPromptSubmit", prompt="x" * (9 << 20)))]
        for env in ({}, {"LOADGUARD_THROTTLE": "0"},
                    {"LOADGUARD_PSI_FULL": "1", "LOADGUARD_SWAP_USED": "1"}):
            for event, stdin in cases:
                for argv in ([BIN["hook"]], [starter, data]):
                    with self.subTest(env=env, stdin=stdin[:40], argv=argv[0]):
                        self.assert_context_or_nothing(
                            run(argv, stdin, base_env(**env)), event)
        proc = subprocess.run([BIN["hook"]], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=10, env=base_env())
        self.assertEqual((proc.returncode, proc.stdout), (0, b""))

    def test_context_path_runtime(self):
        # Every prompt of every session pays this: two kernel files, no scan.
        for event in CONTEXT_EVENTS:
            stdin, times = event_payload(event), []
            for _ in range(100):
                start = time.perf_counter()
                proc = run([BIN["hook"]], stdin)
                times.append((time.perf_counter() - start) * 1000)
                self.assert_context_or_nothing(proc, event)
            sys.stderr.write("[%s n=100: median %.2f ms] "
                             % (event, statistics.median(times)))
            self.assertLess(statistics.median(times), 30)

    def test_other_arguments_are_the_hook(self):
        # Only exactly `--report` or `--explain` switch modes; any other
        # call is the hook as before.
        for argv in (["--bogus"], ["--report", "x"], ["--explain", "x"],
                     ["-report"], ["--REPORT"]):
            with self.subTest(argv=argv):
                proc = run([BIN["hook"]] + argv, payload("git status"))
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))
                proc = run([BIN["hook"]] + argv, b"{")
                self.assertEqual((proc.returncode, proc.stdout), (0, b""))
                self.assertIn(b"pass-through", proc.stderr)


if __name__ == "__main__":
    unittest.main()
