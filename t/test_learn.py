"""The learned list (k15): a Bash call whose processes held
LOADGUARD_LEARN_RSS % of MemTotal is learned by its exact command text, and
the hook calls that text heavy from then on.

setUpModule builds two binaries into a temporary directory:
  hook    the production main (FLAGS + -Werror): hook, reports, --watch
  driver  -DLOADGUARD_TEST (TEST_FLAGS: ASan, UBSan): `extract`, `watch
          SESSION ROOT...` (one watcher pass per fixture root, no sleep),
          `decide`, `explain`, `report`, `slots`
The watcher runs on /proc and cgroup trees in temporary directories: RSS is
a number in a statm file, nothing here allocates memory on purpose. The
Claude Code wrappers and the Codex shell are the ones recorded in
t/fixtures/shells/, the Codex chain the one of
t/fixtures/procs/codex-session.json. One test runs the
production watcher on a real transient scope around `sleep` (skipped
without busctl, a user bus or memory delegation). Without a C compiler every
test is skipped.
"""

import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "lib"))
sys.path.insert(0, HERE)
FIXTURES = os.path.join(ROOT, "t", "fixtures")
SHELLS = os.path.join(FIXTURES, "shells")
CLI = os.path.join(ROOT, "bin", "loadguard")

from loadguard import build, cli, confine, learn  # noqa: E402
from test_confine import Base as ConfineBase  # noqa: E402
from test_confine import SLICE_PATH, real_scope_possible  # noqa: E402
from test_throttle import (CALM, HOME, PROCS, SLICE_CGROUP,  # noqa: E402
                           THRASH, add_process, add_scenario, base_env,
                           codex_payload, payload)

BIN = {}
PAGE = os.sysconf("SC_PAGE_SIZE")
GIB = 1 << 30
MIB = 1 << 20
MEMTOTAL_KB = 8025928                           # reuben
LIMIT = MEMTOTAL_KB * 1024 * 20 // 100          # the default, 20 %
NOW = 1790000000                                # LOADGUARD_TEST_NOW
SCOPE = "loadguard-1f0e2d3c-4100.scope"
SCOPE_PATH = SLICE_PATH + "/" + SCOPE
CODEX_SCOPE_PATH = SLICE_PATH + "/loadguard-019a7c3e-7100.scope"
JSON_DATA = "perl -Ilib t/json_data.t"          # the incidents' 3.2-3.7 GB
PROJECT = HOME + "/dev/p5-json-schema-modern"


def setUpModule():
    cc = build.find_cc()
    if cc is None:
        raise unittest.SkipTest("no C compiler (cc/gcc/$CC) on PATH")
    tmp = tempfile.mkdtemp(prefix="loadguard-learn-")
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


def run(argv, stdin=b"{}", env=None, timeout=30):
    return subprocess.run(argv, input=stdin, capture_output=True,
                          timeout=timeout,
                          env=base_env() if env is None else env)


def stamp(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def recorded(name="claude-code"):
    with open(os.path.join(SHELLS, name + ".json"), encoding="utf-8") as f:
        return json.load(f)["cases"]


# The part of Claude Code's wrapper before the command, as recorded.
PRELUDE = recorded()[0]["argv"][2].split("eval ", 1)[0] + "eval "


def claude_wrapper(command, cwd_file="/tmp/claude-1a2b-cwd", stdin=True):
    """argv of the shell Claude Code 2.1.283 runs a Bash call in: the
    command single-quoted, a quote inside written '"'"', then ` < /dev/null`
    unless the command has a heredoc or its own stdin (recorded)."""
    word = "'" + command.replace("'", "'\"'\"'") + "'"
    return ["/bin/bash", "-c", PRELUDE + word +
            (" < /dev/null" if stdin else "") + " && pwd -P >| " + cwd_file]


def codex_chain():
    """The Codex TUI session of codex-session.json, as {pid: spec}."""
    with open(os.path.join(PROCS, "codex-session.json"),
              encoding="utf-8") as f:
        return {p["pid"]: p for p in json.load(f)["processes"]}


# --- the command behind a shell -------------------------------------------------

class Extract(unittest.TestCase):
    def extract(self, argv, harness="claude"):
        proc = run([BIN["driver"], "extract"],
                   json.dumps({"argv": argv, "harness": harness}).encode())
        self.assertEqual(proc.stderr, b"")
        return proc.stdout.decode("utf-8") if proc.returncode == 0 else None

    def test_recorded_claude_code_wrappers(self):
        # Every recorded wrapper gives back the command as sent, byte for
        # byte: quotes, heredoc, newline, backslashes, UTF-8, a leading
        # `cd`, run_in_background, leading and trailing blanks.
        cases = recorded()
        self.assertEqual(len(cases), 10)
        for case in cases:
            with self.subTest(case=case["case"]):
                for harness in ("claude", "any"):
                    self.assertEqual(self.extract(case["argv"], harness),
                                     case["command"])

    def test_the_wrapper_as_recorded(self):
        # claude_wrapper() builds exactly what was recorded, so the
        # scenarios below use wrappers as Claude Code builds them.
        for case in recorded():
            with self.subTest(case=case["case"]):
                s = case["argv"][2]
                cwd_file = s.rsplit(" ", 1)[1]
                self.assertEqual(claude_wrapper(
                    case["command"], cwd_file,
                    "' < /dev/null && pwd -P >| " in s), case["argv"])

    def test_both_quote_spellings(self):
        # 2.1.283 writes a quote as '"'"'; the shell's other spelling '\''
        # reads the same.
        for word in ("'it'\"'\"'s'", "'it'\\''s'"):
            argv = ["/bin/bash", "-c", PRELUDE + word +
                    " < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"]
            self.assertEqual(self.extract(argv), "it's")

    def test_double_quotes_and_escapes(self):
        argv = ["/bin/bash", "-c", "eval \"a\\\"b\\\\c\\$d\\x\"\\ \\e"
                " && pwd -P >| /tmp/claude-1a2b-cwd"]
        self.assertEqual(self.extract(argv), "a\"b\\c$d\\x e")

    def test_not_the_wrapper(self):
        tail = " < /dev/null && pwd -P >| /tmp/claude-1a2b-cwd"
        for argv in (
                ["/bin/bash", "-c", PRELUDE + "'ls'"],          # no ending
                ["/bin/bash", "-c", PRELUDE + "'ls'" + tail + "; rm x"],
                ["/bin/bash", "-c", PRELUDE + "'ls" + tail],    # open quote
                ["/bin/bash", "-c", PRELUDE + "ls" + tail],     # unquoted
                ["/bin/bash", "-c", PRELUDE + "'ls'$x" + tail],
                ["/bin/bash", "-c", PRELUDE + "\"$(id)\"" + tail],
                ["/bin/bash", "-c", PRELUDE + "\"`id`\"" + tail],
                ["/bin/bash", "-c", PRELUDE + "'ls'*" + tail],
                ["/bin/bash", "-c", PRELUDE +
                 "'ls' && pwd -P >| /tmp/claude-1a2b"],         # no -cwd
                ["/bin/bash", "-c", PRELUDE +
                 "'ls' && pwd -P >| /tmp/x y-cwd"],
                ["/bin/bash", "-c", "source x && evaluate 'ls'" + tail],
                ["/bin/bash", "-c", "sh -c 'context7-mcp'"],
                ["/bin/bash", "-c", "prove -lr t/"]):
            with self.subTest(argv=argv[2][-60:]):
                self.assertIsNone(self.extract(argv))

    def test_not_a_shell_with_code(self):
        for argv in (["perl", "-e", "print 1"], ["/bin/bash", "-x", "a.sh"],
                     ["/bin/bash", "-c"], ["/bin/bash"], [],
                     ["/usr/bin/fish", "-c", "ls"],
                     ["/bin/bash", "-e", "-c", "ls"],
                     ["codex-linux-sandbox", "--", "/bin/bash", "-c", "ls"]):
            with self.subTest(argv=argv):
                for harness in ("claude", "codex", "any"):
                    self.assertIsNone(self.extract(argv, harness))

    def test_recorded_codex_shell(self):
        # Live, codex-cli 0.153.4: the shell's argv[2] is the model's
        # command byte for byte, and only the codex form reads it.
        cases = recorded("codex")
        self.assertEqual(len(cases), 1)
        for case in cases:
            with self.subTest(case=case["case"]):
                for harness in ("codex", "any"):
                    self.assertEqual(self.extract(case["argv"], harness),
                                     case["command"])
                self.assertIsNone(self.extract(case["argv"], "claude"))

    def test_codex_takes_the_string(self):
        # Codex runs `<shell> -c|-lc <command>`; with its shell snapshot the
        # script execs exactly that (codex-rs core/src/shell.rs:22-31,
        # tools/runtimes/mod.rs:225-302), as recorded above; the chain's
        # shell has that form.
        chain = codex_chain()
        argv = chain[7203]["argv"]
        self.assertEqual(argv, ["/bin/bash", "-c",
                                'prove -lr t/; echo "exit $?"'])
        for shell in ("/bin/bash", "/usr/bin/zsh", "sh", "/bin/dash"):
            for flag in ("-c", "-lc"):
                with self.subTest(shell=shell, flag=flag):
                    self.assertEqual(self.extract([shell, flag, JSON_DATA],
                                                  "codex"), JSON_DATA)
                    self.assertEqual(self.extract([shell, flag, JSON_DATA],
                                                  "any"), JSON_DATA)
                    self.assertIsNone(self.extract([shell, flag, JSON_DATA],
                                                   "claude"))

    def test_harness_picks_the_form(self):
        wrapper = claude_wrapper(JSON_DATA)
        self.assertEqual(self.extract(wrapper, "claude"), JSON_DATA)
        self.assertEqual(self.extract(wrapper, "any"), JSON_DATA)
        self.assertEqual(self.extract(wrapper, "codex"), wrapper[2])


# --- the watcher -----------------------------------------------------------------

def proc_spec(pid, ppid, comm, argv, rss, cwd=None, start=100):
    return {"pid": pid, "ppid": ppid, "comm": comm, "argv": argv, "rss": rss,
            "cwd": cwd, "start": start}


def claude_session(start=50):
    """claude (4100) with an MCP server behind `sh -c` (as on reuben)."""
    return [proc_spec(4100, 4000, "claude",
                      ["/home/getty/.local/bin/claude"], 300 * MIB, HOME,
                      start),
            proc_spec(4110, 4100, "npm exec @upsta",
                      ["npm exec @upstash/context7-mcp@latest", "", ""],
                      40 * MIB, HOME),
            proc_spec(4111, 4110, "sh", ["sh", "-c", "context7-mcp"],
                      2 * MIB, HOME),
            proc_spec(4112, 4111, "MainThread",
                      ["node", "/home/getty/.npm/_npx/c35a/node_modules/.bin/"
                       "context7-mcp"], 60 * MIB, HOME)]


def json_data_run(perl_rss, command=JSON_DATA, shell=4300):
    """The Bash call running a test file straight with perl."""
    procs = [proc_spec(shell, 4100, "bash", claude_wrapper(command),
                       4 * MIB, PROJECT)]
    if perl_rss is not None:
        procs.append(proc_spec(shell + 1, shell, "perl",
                               ["/usr/bin/perl", "-Ilib", "t/json_data.t"],
                               perl_rss, PROJECT))
    return procs


class Watch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loadguard-watch-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        self.runtime = os.path.join(self.tmp, "run")
        os.makedirs(self.runtime)
        self.passes = 0

    def root(self, procs, scope_path=SCOPE_PATH, outside=()):
        """One pass: a fresh tree with procs in the scope, `outside` not."""
        self.passes += 1
        root = os.path.join(self.tmp, "pass%d" % self.passes)
        os.makedirs(os.path.join(root, "proc"))
        with open(os.path.join(root, "proc", "meminfo"), "w") as f:
            f.write("MemTotal:        %d kB\nMemAvailable:    2469728 kB\n"
                    % MEMTOTAL_KB)
        members = []
        for p in list(procs) + list(outside):
            cgroup = "0::" + (scope_path if p in procs else
                              "/user.slice/user-1000.slice/session-3.scope")
            d = add_process(root, p["pid"], p["ppid"], p["comm"], p["argv"],
                            cgroup, p["cwd"])
            with open(os.path.join(d, "stat"), "w") as f:
                f.write("%d (%s) S %d %d %d 0 -1 4194304 0 0 0 0 0 0 0 0 20 "
                        "0 1 0 %d 0 0\n" % (p["pid"], p["comm"], p["ppid"],
                                            p["pid"], p["pid"], p["start"]))
            with open(os.path.join(d, "statm"), "w") as f:
                f.write("%d %d 100 10 0 50 0\n"
                        % (p["rss"] // PAGE * 2, p["rss"] // PAGE))
            if p in procs:
                members.append(p["pid"])
        cg = root + "/sys/fs/cgroup" + scope_path
        os.makedirs(cg, exist_ok=True)
        with open(os.path.join(cg, "cgroup.procs"), "w") as f:
            f.write("".join("%d\n" % pid for pid in members))
        return root

    def watch(self, roots, session=4100, **env):
        """(events, final status) of one watcher over the passes."""
        settings = {"XDG_STATE_HOME": self.state,
                    "XDG_RUNTIME_DIR": self.runtime,
                    "LOADGUARD_TEST_NOW": str(NOW)}
        settings.update(env)
        environ = base_env(**settings)
        proc = run([BIN["driver"], "watch", str(session)] + roots,
                   env=environ)
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        lines = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(list(lines[-1]), ["watch"])
        return lines[:-1], lines[-1]["watch"]

    def events(self, events):
        return [(e["tick"], e["event"]) + ((e["why"],) if "why" in e else ())
                for e in events]

    def learned(self):
        entries, problem = learn.read(os.path.join(self.state, "loadguard",
                                                   "learned.jsonl"))
        self.assertIsNone(problem)
        return entries

    def write_list(self, lines):
        d = os.path.join(self.state, "loadguard")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "learned.jsonl"), "w") as f:
            f.write(lines)

    def test_the_json_data_case(self):
        # Below the limit; over it: written at once; 6.6 % more: not
        # rewritten; 13 % more: rewritten; perl gone, the shell still
        # there: nothing; the shell gone: the last word.
        s = claude_session()
        roots = [self.root(s + json_data_run(1 * GIB)),
                 self.root(s + json_data_run(3 * GIB)),
                 self.root(s + json_data_run(int(3.2 * GIB))),
                 self.root(s + json_data_run(int(3.4 * GIB))),
                 self.root(s + json_data_run(None)),
                 self.root(s)]
        events, status = self.watch(roots)
        self.assertEqual(status, "done")
        self.assertEqual(self.events(events),
                         [(2, "learn"), (4, "grow"), (6, "end")])
        self.assertEqual(events[0]["peak"], 3 * GIB + 4 * MIB)
        self.assertEqual(events[0]["command"], JSON_DATA)
        peak = int(3.4 * GIB) // PAGE * PAGE + 4 * MIB
        self.assertEqual(self.learned(), [{
            "command": JSON_DATA, "peak_rss": peak, "cwd": PROJECT,
            "first_seen": stamp(NOW + 2), "last_seen": stamp(NOW + 10)}])

    def test_below_the_limit_nothing(self):
        s = claude_session()
        rss = LIMIT - 4 * MIB - 2 * PAGE
        events, _ = self.watch([self.root(s + json_data_run(rss))] * 3)
        self.assertEqual(events, [])
        self.assertEqual(self.learned(), [])
        # The same call at a lower limit is learned.
        events, _ = self.watch([self.root(s + json_data_run(rss))],
                               LOADGUARD_LEARN_RSS="10")
        self.assertEqual(self.events(events), [(1, "learn")])

    def test_limit_from_env(self):
        s = claude_session()
        roots = [self.root(s + json_data_run(3 * GIB)), self.root(s)]
        for value in ("50", "50%"):      # 3.8 GiB of reuben's 7.65
            with self.subTest(value=value):
                self.assertEqual(self.watch(roots, LOADGUARD_LEARN_RSS=value)
                                 [0], [])
        for value in ("0", "101", "x", "20.5"):     # the default, 20 %
            with self.subTest(value=value):
                events, _ = self.watch(roots, LOADGUARD_LEARN_RSS=value)
                self.assertEqual(self.events(events),
                                 [(1, "learn"), (2, "end")])

    def test_fixed_list_not_learned(self):
        # `make test` is heavy already: never a second time in the list.
        s = claude_session()
        run_ = json_data_run(3 * GIB, command="cd x && make test")
        events, _ = self.watch([self.root(s + run_), self.root(s)])
        self.assertEqual(self.events(events), [(1, "skip", "fixed")])
        self.assertFalse(os.path.exists(os.path.join(self.state,
                                                     "loadguard")))

    def test_mcp_server_is_no_bash_call(self):
        # Under Claude Code only its wrapper is a Bash call: an MCP server
        # behind `sh -c` that grows is not learned.
        s = claude_session()
        s[3] = dict(s[3], rss=3 * GIB)
        events, _ = self.watch([self.root(s), self.root(s)])
        self.assertEqual(self.events(events), [(1, "skip", "form")])
        self.assertEqual(self.learned(), [])

    def test_cmdline_read_once(self):
        # A call over the limit that is not learned stays tracked: its
        # cmdline is not read again. A FIFO in its place in the second
        # pass would block any reader.
        s = claude_session()
        s[3] = dict(s[3], rss=3 * GIB)
        first = self.root(s)
        second = self.root(s)
        cmdline = os.path.join(second, "proc", "4111", "cmdline")
        os.unlink(cmdline)
        os.mkfifo(cmdline)
        start = time.monotonic()
        events, _ = self.watch([first, second])
        self.assertLess(time.monotonic() - start, 10)
        self.assertEqual(self.events(events), [(1, "skip", "form")])

    def test_the_subtree_counts_together(self):
        # Three perl children of 600 MiB each: none alone is over the
        # limit, their shell's subtree is.
        s = claude_session()
        run_ = json_data_run(None, command="make -j3 bench")
        for i in range(3):
            run_.append(proc_spec(4301 + i, 4300, "perl",
                                  ["/usr/bin/perl", "bench%d.pl" % i],
                                  600 * MIB, PROJECT))
        events, _ = self.watch([self.root(s + run_)])
        self.assertEqual(self.events(events), [(1, "learn")])
        self.assertEqual(events[0]["peak"], 1804 * MIB)

    def test_topmost_shell_is_the_call(self):
        # The command runs `bash -c` itself: the wrapper above it is the
        # call, and its text is what gets learned.
        s = claude_session()
        command = "bash -c 'perl -Ilib t/json_data.t'"
        run_ = json_data_run(None, command=command)
        run_ += [proc_spec(4301, 4300, "bash", ["bash", "-c", JSON_DATA],
                           3 * MIB, PROJECT),
                 proc_spec(4302, 4301, "perl", ["perl", "t/json_data.t"],
                           3 * GIB, PROJECT)]
        events, _ = self.watch([self.root(s + run_)])
        self.assertEqual([e["command"] for e in events], [command])

    def test_two_calls_at_once(self):
        s = claude_session()
        roots = [self.root(s + json_data_run(2 * GIB) +
                           json_data_run(2 * GIB, "perl t/big.t", 4400)),
                 self.root(s)]
        events, _ = self.watch(roots)
        self.assertEqual(sorted(self.events(events)),
                         [(1, "learn"), (1, "learn"), (2, "end"),
                          (2, "end")])
        self.assertEqual(sorted(e["command"] for e in self.learned()),
                         [JSON_DATA, "perl t/big.t"])

    def test_orphans_are_nobodys(self):
        # A job whose shell has exited (`foo &`) hangs off init: no call
        # to learn it for.
        s = claude_session()
        orphan = proc_spec(4500, 1, "perl", ["perl", "daemon.pl"], 3 * GIB)
        events, _ = self.watch([self.root(s + [orphan])])
        self.assertEqual(events, [])

    def test_repeat_run_updates_the_entry(self):
        s = claude_session()
        self.watch([self.root(s + json_data_run(3 * GIB)), self.root(s)])
        first = self.learned()
        events, _ = self.watch([self.root(s + json_data_run(2 * GIB)),
                                self.root(s)], LOADGUARD_TEST_NOW=str(
                                    NOW + 86400))
        self.assertEqual(self.events(events), [(1, "learn"), (2, "end")])
        (entry,) = self.learned()
        # The peak is the highest ever seen, first_seen stays.
        self.assertEqual(entry["peak_rss"], first[0]["peak_rss"])
        self.assertEqual(entry["first_seen"], stamp(NOW))
        self.assertEqual(entry["last_seen"], stamp(NOW + 86400 + 2))

    def test_session_gone_mid_command(self):
        # The command is learned the moment it crosses the limit; when the
        # session process is gone (or its PID reused: another start time),
        # the watcher writes the last word and stops.
        s = claude_session()
        busy = self.root(s + json_data_run(3 * GIB))
        for later in (self.root(s[1:] + json_data_run(4 * GIB)),
                      self.root(claude_session(start=9999)[:1] + s[1:] +
                                json_data_run(4 * GIB))):
            with self.subTest(later=later):
                events, status = self.watch([busy, later, busy])
                self.assertEqual(status, "gone")
                self.assertEqual(self.events(events),
                                 [(1, "learn"), (2, "end")])
                self.assertEqual(self.learned()[0]["peak_rss"],
                                 3 * GIB + 4 * MIB)

    def test_scope_gone(self):
        s = claude_session()
        busy = self.root(s + json_data_run(3 * GIB))
        gone = self.root(s + json_data_run(3 * GIB))
        os.unlink(os.path.join(gone, "sys/fs/cgroup" + SCOPE_PATH,
                               "cgroup.procs"))
        _, status = self.watch([busy, gone, busy])
        self.assertEqual(status, "gone")

    def test_nothing_to_watch(self):
        # Not claude or codex; not in a loadguard-*.scope; no MemTotal.
        s = claude_session()
        cases = {"bash": self.root([dict(s[0], comm="bash",
                                         argv=["bash"])]),
                 "session scope": self.root(s, scope_path="/user.slice/"
                                            "user-1000.slice/session-3.scope"),
                 "other scope": self.root(s, scope_path=SLICE_PATH +
                                          "/other.scope")}
        root = self.root(s)
        os.unlink(os.path.join(root, "proc", "meminfo"))
        cases["no meminfo"] = root
        for name, root in cases.items():
            with self.subTest(name):
                self.assertEqual(self.watch([root]), ([], "no-scope"))
        self.assertEqual(self.watch([self.root(s)], session=4999),
                         ([], "no-scope"))

    def test_argv0_names_the_harness(self):
        # npm's launcher: comm node, argv[0] …/claude (confine.py's rule).
        s = claude_session()
        s[0] = dict(s[0], comm="node")
        events, _ = self.watch([self.root(s + json_data_run(3 * GIB))])
        self.assertEqual(self.events(events), [(1, "learn")])

    def test_one_watcher_per_scope(self):
        # A resumed session, a nested claude -p, an app-server thread: the
        # scope is watched already, the second watcher ends at once.
        path = os.path.join(self.runtime, "loadguard", SCOPE + ".watch")
        os.makedirs(os.path.dirname(path))
        s = claude_session()
        with open(path, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.assertEqual(self.watch([self.root(s + json_data_run(
                3 * GIB))]), ([], "locked"))
        self.assertEqual(self.watch([self.root(s)]), ([], "done"))
        # The lock file goes with the watcher.
        self.assertFalse(os.path.exists(path))

    def test_no_runtime_dir_no_watcher(self):
        s = claude_session()
        proc = run([BIN["driver"], "watch", "4100", self.root(s)],
                   env=base_env(XDG_STATE_HOME=self.state))
        self.assertEqual(proc.stdout, b'{"watch":"locked"}\n')

    def test_codex_session(self):
        # The sandbox helpers (codex-linux-sandbox, bwrap, the helper as
        # PID 1) are no shells: the call is `bash -c <command>` inside,
        # its argv[2] the command — a `;` list, so bash stays.
        command = JSON_DATA + '; echo "exit $?"'
        chain = codex_chain()
        procs = []
        for pid in (7100, 7110, 7200, 7201, 7202, 7203):
            p = chain[pid]
            procs.append(proc_spec(pid, p["ppid"], p["comm"], p["argv"],
                                   8 * MIB, p["cwd"], 30 if pid == 7100
                                   else 100))
        procs[-1]["argv"] = ["/bin/bash", "-c", command]
        procs.append(proc_spec(7204, 7203, "perl", ["/usr/bin/perl",
                                                    "t/json_data.t"],
                               3 * GIB, chain[7203]["cwd"]))
        roots = [self.root(procs, CODEX_SCOPE_PATH),
                 self.root(procs[:-2], CODEX_SCOPE_PATH)]
        events, _ = self.watch(roots, session=7100)
        self.assertEqual(self.events(events), [(1, "learn"), (2, "end")])
        self.assertEqual(self.learned()[0]["command"], command)
        self.assertEqual(self.learned()[0]["cwd"], HOME + "/dev/simpici")

    def test_codex_lone_command_leaves_no_shell(self):
        # bash 5.2 execs the last command of `-c` (seen on reuben: `bash -c
        # 'cd /tmp && sleep 2'` leaves only sleep), so under Codex a lone
        # command or `cd x && cmd` runs without a shell to read the text
        # from: nothing is learned. Claude Code's wrapper keeps its shell,
        # `&& pwd -P …` follows the eval.
        chain = codex_chain()
        procs = [proc_spec(pid, chain[pid]["ppid"], chain[pid]["comm"],
                           chain[pid]["argv"], 8 * MIB, chain[pid]["cwd"],
                           30 if pid == 7100 else 100)
                 for pid in (7100, 7200, 7201, 7202)]
        procs.append(proc_spec(7203, 7202, "perl", ["perl", "t/json_data.t"],
                               3 * GIB, chain[7202]["cwd"]))
        events, _ = self.watch([self.root(procs, CODEX_SCOPE_PATH)],
                               session=7100)
        self.assertEqual(events, [])

    def test_codex_takes_no_claude_wrapper_text(self):
        # The same wrapper under a codex session is not unwrapped: Codex's
        # command is the string itself.
        s = claude_session()
        s[0] = dict(s[0], comm="codex", argv=["codex"])
        events, _ = self.watch([self.root(s + json_data_run(3 * GIB))])
        self.assertEqual(events[0]["command"], claude_wrapper(JSON_DATA)[2])

    def test_long_or_empty_text_not_learned(self):
        s = claude_session()
        long_run = json_data_run(3 * GIB, command="echo " + "x" * 4092)
        events, _ = self.watch([self.root(s + long_run)])
        self.assertEqual(self.events(events), [(1, "skip", "text")])
        empty_run = json_data_run(3 * GIB, command="")
        events, _ = self.watch([self.root(s + empty_run)])
        self.assertEqual(self.events(events), [(1, "skip", "text")])
        ok_run = json_data_run(3 * GIB, command="echo " + "x" * 4091)
        events, _ = self.watch([self.root(s + ok_run)])
        self.assertEqual(self.events(events), [(1, "learn")])

    def test_not_utf8_not_learned(self):
        # A command the hook could never be sent: invalid UTF-8.
        s = claude_session()
        root = self.root(s + json_data_run(3 * GIB))
        with open(os.path.join(root, "proc", "4300", "cmdline"), "wb") as f:
            f.write(b"/bin/bash\0-c\0" + PRELUDE.encode() +
                    b"'ls \xff' < /dev/null && pwd -P >| /tmp/claude-1-cwd\0")
        events, _ = self.watch([root])
        self.assertEqual(self.events(events), [(1, "skip", "text")])

    def test_list_keeps_a_hundred(self):
        # Above 100 entries the one longest not seen big goes.
        lines = "".join(json.dumps({
            "command": "old %03d" % i, "peak_rss": GIB,
            "last_seen": "2026-09-%02dT00:00:00Z" % (1 + i % 20)}) + "\n"
            for i in range(100))
        self.write_list(lines)
        s = claude_session()
        self.watch([self.root(s + json_data_run(3 * GIB))])
        commands = [e["command"] for e in self.learned()]
        self.assertEqual(len(commands), 100)
        self.assertNotIn("old 000", commands)      # 2026-09-01, first
        self.assertIn("old 020", commands)         # 2026-09-01 as well
        self.assertEqual(commands[-1], JSON_DATA)

    def test_broken_lines_dropped_oversized_replaced(self):
        good = json.dumps({"command": "kept", "peak_rss": GIB}) + "\n"
        self.write_list("garbage\n[1]\n{\"command\": 5}\n" + good + "{\n")
        s = claude_session()
        self.watch([self.root(s + json_data_run(3 * GIB))])
        self.assertEqual([e["command"] for e in self.learned()],
                         ["kept", JSON_DATA])
        self.write_list(good * (learn.MAX_BYTES // len(good) + 1))
        self.watch([self.root(s + json_data_run(3 * GIB))])
        self.assertEqual([e["command"] for e in self.learned()], [JSON_DATA])

    def test_list_is_private(self):
        s = claude_session()
        self.watch([self.root(s + json_data_run(3 * GIB))])
        d = os.path.join(self.state, "loadguard")
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(d, "learned.jsonl")).st_mode
                         & 0o777, 0o600)
        self.assertEqual(sorted(os.listdir(d)),
                         ["learned.jsonl", "learned.lock"])

    def test_learning_off(self):
        proc = run([BIN["hook"], "--watch", "4100"],
                   env=base_env(LOADGUARD_LEARN="0",
                                XDG_RUNTIME_DIR=self.runtime))
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (0, b"", b""))
        self.assertEqual(os.listdir(self.runtime), [])


class ProductionWatchMode(unittest.TestCase):
    """--watch in the production binary: quiet, never blocks on stdin, ends
    at once where there is nothing to watch."""

    def test_nothing_to_watch_ends_at_once(self):
        r, w = os.pipe()
        self.addCleanup(os.close, r)
        self.addCleanup(os.close, w)
        for arg in ("", "x", "0", "1", "-5", "12x", "99999999999",
                    str(os.getpid()), "4194303"):
            with self.subTest(arg=arg):
                start = time.monotonic()
                proc = subprocess.run([BIN["hook"], "--watch", arg], stdin=r,
                                      capture_output=True, timeout=10,
                                      env=base_env())
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))
                self.assertLess(time.monotonic() - start, 5)

    def test_other_arguments_are_the_hook(self):
        for argv in (["--watch"], ["--watch", "1", "2"], ["-watch", "1"]):
            with self.subTest(argv=argv):
                proc = run([BIN["hook"]] + argv, payload("git status"))
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))


@unittest.skipUnless(real_scope_possible(),
                     "no busctl, user bus or memory delegation")
class RealWatcher(unittest.TestCase):
    """The production watcher on a real scope around a `sleep` that is
    called claude: one per scope, gone within a tick of the session, and
    the scope with it. No load: nothing gets near the limit."""

    def test_watches_until_the_session_is_gone(self):
        busctl = real_scope_possible()
        tmp = tempfile.mkdtemp(prefix="loadguard-realwatch-")
        self.addCleanup(shutil.rmtree, tmp, True)
        fake = os.path.join(tmp, "claude")
        os.symlink(shutil.which("sleep"), fake)
        claude = subprocess.Popen([fake, "60"])
        self.addCleanup(claude.wait)
        self.addCleanup(claude.kill)
        name = "loadguard-test-%d.scope" % claude.pid
        self.assertTrue(confine.start_scope(
            busctl, name, [claude.pid], {"MemoryMax": 64 << 20},
            "loadguard: unit test"))
        self.assertTrue(confine.wait_attached("", claude.pid, name))
        env = base_env(XDG_RUNTIME_DIR=os.path.join(tmp, "run"),
                       XDG_STATE_HOME=os.path.join(tmp, "state"))
        watcher = subprocess.Popen(
            [BIN["hook"], "--watch", str(claude.pid)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        self.addCleanup(lambda: watcher.poll() is None and watcher.kill())
        self.assertTrue(confine.attach(busctl, name, [watcher.pid]))
        lock = os.path.join(tmp, "run", "loadguard", name + ".watch")

        def held():
            try:
                with open(lock) as f:
                    return f.read()
            except FileNotFoundError:
                return ""
        deadline = time.monotonic() + 5
        while not held():
            self.assertLess(time.monotonic(), deadline, "no lock file")
            time.sleep(0.05)
        self.assertEqual(held(), "%d\n" % watcher.pid)
        self.assertEqual(learn.watcher(env, name), watcher.pid)
        # A second watcher for the scope ends at once.
        start = time.monotonic()
        second = run([BIN["hook"], "--watch", str(claude.pid)], env=env,
                     timeout=10)
        self.assertEqual((second.returncode, second.stdout), (0, b""))
        self.assertLess(time.monotonic() - start, 1.5)
        claude.kill()
        claude.wait()
        # Within a tick (2 s) the watcher is gone, and the scope with it.
        deadline = time.monotonic() + 6
        while True:
            pid, status, usage = os.wait4(watcher.pid, os.WNOHANG)
            if pid:
                break
            self.assertLess(time.monotonic(), deadline, "watcher lingers")
            time.sleep(0.05)
        watcher.returncode = os.waitstatus_to_exitcode(status)
        self.assertEqual(watcher.returncode, 0)
        # Never spinning: a few reads per 2 s.
        self.assertLess(usage.ru_utime + usage.ru_stime, 0.2)
        self.assertFalse(os.path.exists(lock))
        self.assertFalse(os.path.exists(os.path.join(tmp, "state")))
        deadline = time.monotonic() + 5
        while subprocess.run(["systemctl", "--user", "list-units", "--all",
                              "--no-legend", name], capture_output=True,
                             text=True, timeout=10).stdout.strip():
            self.assertLess(time.monotonic(), deadline, "scope lingers")
            time.sleep(0.05)


# --- the hook ---------------------------------------------------------------------

class Hook(unittest.TestCase):
    """decide / explain / report with a learned list in XDG_STATE_HOME."""

    ENTRY = {"command": JSON_DATA, "peak_rss": int(3.4 * GIB) + 4 * MIB,
             "cwd": PROJECT, "first_seen": "2026-09-12T22:43:40Z",
             "last_seen": "2026-09-21T05:18:28Z"}
    LABEL = "learned: peaked at 3.4 GiB RSS on 2026-09-21"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loadguard-learned-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        self.path = os.path.join(self.state, "loadguard", "learned.jsonl")
        self.write([self.ENTRY])

    def write(self, entries, raw=None):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if os.path.lexists(self.path) and not os.path.isfile(self.path):
            if os.path.isdir(self.path):
                os.rmdir(self.path)
            else:
                os.unlink(self.path)
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(raw if raw is not None else "".join(
                json.dumps(e) + "\n" for e in entries))

    def tree(self, pressure=None, scenarios=()):
        root = os.path.join(tempfile.mkdtemp(dir=self.tmp), "root")
        if pressure is None:
            os.makedirs(os.path.join(root, "proc"))
        else:
            shutil.copytree(pressure, root, symlinks=True)
        for name in scenarios:
            add_scenario(root, name)
        return root

    def env(self, **extra):
        env = {"XDG_STATE_HOME": self.state}
        env.update(extra)
        return base_env(**env)

    def decide(self, root, command, stdin=None, **env):
        proc = run([BIN["driver"], "decide", root],
                   payload(command) if stdin is None else stdin,
                   self.env(**env))
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        return proc.stdout

    def reason(self, root, command, **env):
        out = self.decide(root, command, **env)
        self.assertTrue(out, "not denied: %r" % command)
        return json.loads(out)["hookSpecificOutput"][
            "permissionDecisionReason"]

    def report(self, root, mode="report", stdin=b"{}", **env):
        proc = run([BIN["driver"], mode, root], stdin, self.env(**env))
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        return json.loads(proc.stdout)

    def test_denied_under_pressure(self):
        self.assertEqual(
            self.reason(self.tree(THRASH), JSON_DATA),
            "loadguard: heavy command refused (%s): memory pressure "
            "full=59.9%% (limit 10%%), swap 100%% used (limit 90%%).\n"
            "Wait and retry later; light commands (git status, ls, cat) "
            "still run." % self.LABEL)

    def test_allowed_when_calm(self):
        self.assertEqual(self.decide(self.tree(CALM, ["idle-sessions"]),
                                     JSON_DATA), b"")

    def test_exact_text_only(self):
        root = self.tree(THRASH)
        for command in (JSON_DATA + " ", " " + JSON_DATA,
                        "cd x && " + JSON_DATA, JSON_DATA + "\n",
                        "perl  -Ilib t/json_data.t", "perl -Ilib t/json_data",
                        JSON_DATA.upper()):
            with self.subTest(command=command):
                self.assertEqual(self.decide(root, command), b"")

    def test_switches(self):
        root = self.tree(THRASH)
        self.assertEqual(self.decide(root, JSON_DATA, LOADGUARD_LEARN="0"),
                         b"")
        self.assertEqual(self.decide(root, JSON_DATA, LOADGUARD_THROTTLE="0"),
                         b"")
        for value in ("", "00", "off", "no", " 0"):
            with self.subTest(value=value):
                self.reason(root, JSON_DATA, LOADGUARD_LEARN=value)

    def test_the_fixed_list_names_it_first(self):
        self.write([dict(self.ENTRY, command="prove -lr t/")])
        self.assertIn("refused (prove): ",
                      self.reason(self.tree(THRASH), "prove -lr t/"))

    def test_label(self):
        root = self.tree(THRASH)
        for entry, label in (
                ({}, self.LABEL),
                ({"peak_rss": 640 * MIB}, "learned: peaked at 640 MiB RSS "
                                          "on 2026-09-21"),
                ({"peak_rss": None}, "learned on 2026-09-21"),
                ({"last_seen": "yesterday"}, "learned: peaked at 3.4 GiB "
                                             "RSS"),
                ({"last_seen": "2026-09-21\nWait"}, self.LABEL),
                ({"last_seen": "2026/09/21T00"}, "learned: peaked at 3.4 GiB "
                                                 "RSS"),
                ({"peak_rss": "3 GB", "last_seen": 5}, "learned")):
            with self.subTest(entry=entry):
                self.write([dict(self.ENTRY, **entry)])
                self.assertIn("refused (%s): " % label,
                              self.reason(root, JSON_DATA))

    def test_list_lines(self):
        # Broken lines are skipped, the rest still counts; at most 256
        # lines are read.
        root = self.tree(THRASH)
        good = json.dumps(self.ENTRY) + "\n"
        self.write(None, "garbage\n{\"command\": 5}\n[1]\n\n" + good +
                   json.dumps(self.ENTRY)[:-1] + "\n")
        self.reason(root, JSON_DATA)
        self.write(None, "{}\n" * 255 + good)
        self.reason(root, JSON_DATA)
        self.write(None, "{}\n" * 256 + good)
        self.assertEqual(self.decide(root, JSON_DATA), b"")

    def test_unusable_list_is_empty(self):
        root = self.tree(THRASH)
        good = json.dumps(self.ENTRY) + "\n"
        self.write(None, good * ((1 << 20) // len(good) + 1))
        self.assertEqual(self.decide(root, JSON_DATA), b"")
        self.assertEqual(self.report(root)["learn"]["state"], "too-large")
        os.unlink(self.path)
        os.mkdir(self.path)
        self.assertEqual(self.decide(root, JSON_DATA), b"")
        self.assertEqual(self.report(root)["learn"]["state"], "unreadable")
        os.rmdir(self.path)
        self.assertEqual(self.report(root)["learn"]["state"], "none")

    def test_fifo_list_does_not_block(self):
        # The light path now opens the list: a FIFO there must not hang it.
        root = self.tree(THRASH)
        os.unlink(self.path)
        os.mkfifo(self.path)
        start = time.monotonic()
        for command in ("git status", JSON_DATA):
            self.assertEqual(self.decide(root, command), b"")
        self.assertEqual(self.report(root)["learn"]["state"], "unreadable")
        self.assertLess(time.monotonic() - start, 10)

    def test_running_learned_command_holds_a_slot(self):
        # Claude Code's wrapper around the learned command, a perl below:
        # one slot, named by the command.
        root = self.tree(CALM, ["idle-sessions"])
        add_process(root, 8001, 4100, "bash", claude_wrapper(JSON_DATA),
                    SLICE_CGROUP, PROJECT)
        add_process(root, 8002, 8001, "perl",
                    ["/usr/bin/perl", "-Ilib", "t/json_data.t"],
                    SLICE_CGROUP, PROJECT)
        self.assertIn("1/1 heavy slots busy (perl -Ilib t/json_data.t in "
                      "~/dev/p5-json-schema-modern)",
                      self.reason(root, "make test",
                                  LOADGUARD_HEAVY_SLOTS="1"))
        # Without the list (or with learning off) it is a light process.
        for env in ({"LOADGUARD_LEARN": "0"}, {"XDG_STATE_HOME": "/nonexistent"}):
            with self.subTest(env=env):
                self.assertEqual(self.decide(root, "make test",
                                             LOADGUARD_HEAVY_SLOTS="1",
                                             **env), b"")

    def test_codex_shell_holds_a_slot(self):
        root = self.tree(CALM, ["codex-session"])
        with open(os.path.join(root, "proc", "7203", "cmdline"), "wb") as f:
            f.write(b"/bin/bash\0-c\0" + JSON_DATA.encode() + b"\0")
        shutil.rmtree(os.path.join(root, "proc", "7204"))
        shutil.rmtree(os.path.join(root, "proc", "7205"))
        self.assertIn("1/1 heavy slots busy (perl -Ilib t/json_data.t in "
                      "~/dev/simpici)",
                      self.reason(root, "make test",
                                  LOADGUARD_HEAVY_SLOTS="1"))

    def test_topmost_holder_counts(self):
        # A learned call that runs prove below it is one slot, not two.
        command = "bash ./run-tests"
        self.write([dict(self.ENTRY, command=command)])
        root = self.tree(CALM)
        add_process(root, 8001, 4100, "bash", claude_wrapper(command),
                    SLICE_CGROUP, PROJECT)
        add_process(root, 8002, 8001, "prove",
                    ["/usr/bin/perl", "/usr/bin/prove", "-lr", "t/"],
                    SLICE_CGROUP, PROJECT)
        proc = run([BIN["driver"], "slots", root], env=self.env())
        self.assertEqual(proc.stdout.decode().splitlines(),
                         ["1", "bash ./run-tests in "
                               "~/dev/p5-json-schema-modern"])

    def test_holder_label_is_cut_and_clean(self):
        command = "perl -e 'x' # ü " + "y" * 60 + "\nsecond line"
        self.write([dict(self.ENTRY, command=command)])
        root = self.tree(CALM)
        add_process(root, 8001, 4100, "bash", claude_wrapper(command),
                    SLICE_CGROUP, None)
        proc = run([BIN["driver"], "slots", root], env=self.env())
        busy, holder = proc.stdout.decode("utf-8").splitlines()
        self.assertEqual(busy, "1")
        self.assertEqual(len(holder.encode("utf-8")), 47)
        self.assertTrue(holder.startswith("perl -e 'x' # ü yyy"), holder)
        self.assertTrue(holder.endswith("..."), holder)

    def test_cut_off_wrapper_is_no_holder(self):
        # A cmdline longer than the scan reads has lost the wrapper's end.
        command = "echo " + "x" * 70000
        self.write([dict(self.ENTRY, command=command)])
        root = self.tree(CALM)
        add_process(root, 8001, 4100, "bash", claude_wrapper(command),
                    SLICE_CGROUP, None)
        proc = run([BIN["driver"], "slots", root], env=self.env())
        self.assertEqual(proc.stdout, b"0\n")

    def test_explain_names_it(self):
        doc = self.report(self.tree(THRASH), "explain", payload(JSON_DATA))
        self.assertEqual((doc["heavy"], doc["decision"]),
                         (self.LABEL, "deny"))
        self.assertEqual(cli.format_explain(doc, {})[0],
                         "heavy:   yes (%s)" % self.LABEL)

    def test_explain_is_the_hook(self):
        roots = {"calm": self.tree(CALM, ["idle-sessions"]),
                 "thrash": self.tree(THRASH, ["idle-sessions"]),
                 "busy": self.tree(CALM, ["idle-sessions", "prove-chain"])}
        for name, root in roots.items():
            for env in ({}, {"LOADGUARD_HEAVY_SLOTS": "1"},
                        {"LOADGUARD_LEARN": "0"}):
                for command in (JSON_DATA, JSON_DATA + " ", "git status"):
                    with self.subTest(root=name, env=env, command=command):
                        out = self.decide(root, command, **env)
                        doc = self.report(root, "explain", payload(command),
                                          **env)
                        reason = json.loads(out)["hookSpecificOutput"][
                            "permissionDecisionReason"] if out else None
                        self.assertEqual((doc["decision"], doc["reason"]),
                                         ("deny" if out else "allow",
                                          reason))

    def test_codex_payload_same_bytes(self):
        root = self.tree(THRASH)
        want = self.decide(root, JSON_DATA)
        self.assertTrue(want)
        for fixture in ("pre-tool-use.json", "pre-tool-use-subagent.json"):
            self.assertEqual(self.decide(root, None, codex_payload(
                fixture, JSON_DATA)), want)

    def test_report(self):
        root = self.tree(CALM)
        self.write([self.ENTRY, dict(self.ENTRY, command="x")])
        self.assertEqual(self.report(root)["learn"], {
            "on": True, "file": self.path, "state": "ok", "entries": 2,
            "rss_limit": 20})
        doc = self.report(root, LOADGUARD_LEARN="0", LOADGUARD_LEARN_RSS="35%")
        self.assertEqual(doc["learn"], {
            "on": False, "file": self.path, "state": "off", "entries": 0,
            "rss_limit": 35})
        doc = self.report(root, LOADGUARD_LEARN="off",
                          LOADGUARD_LEARN_RSS="0")
        self.assertEqual(doc["ignored"], ["LOADGUARD_LEARN_RSS",
                                          "LOADGUARD_LEARN"])
        self.assertEqual((doc["learn"]["on"], doc["learn"]["rss_limit"]),
                         (True, 20))

    def test_where_the_list_is(self):
        # The binary and learn.py find the same file.
        root = self.tree(CALM)
        for env in ({"XDG_STATE_HOME": "/x/state"},
                    {"XDG_STATE_HOME": "/x/state/"},
                    {"XDG_STATE_HOME": "relative", "HOME": "/h"},
                    {"XDG_STATE_HOME": "", "HOME": "/h"},
                    {"HOME": "/h"},
                    {"HOME": "relative"}, {}):
            with self.subTest(env=env):
                environ = {"PATH": os.environ["PATH"]}
                environ.update(env)
                proc = run([BIN["driver"], "report", root], env=environ)
                got = json.loads(proc.stdout)["learn"]["file"]
                want = learn.list_path(environ)
                self.assertEqual(got and os.path.normpath(got), want)


# --- starting the watcher (hooks/loadguard-confine) ------------------------------

WATCHER_STUB = """#!/bin/sh
fds=$(readlink /proc/$$/fd/0 /proc/$$/fd/1 /proc/$$/fd/2)
{ echo "$*"; echo $$; cat /proc/$$/stat; echo; echo "$fds"; pwd; } \\
  > "$RECORD.tmp" && mv "$RECORD.tmp" "$RECORD"
"""


class Launcher(ConfineBase):
    """learn.start_watcher on the fake host of test_confine.py."""

    def setUp(self):
        super().setUp()
        self.data = os.path.join(os.path.dirname(self.t.root), "data")
        os.makedirs(os.path.join(self.data, "bin"))
        binary = os.path.join(self.data, "bin", "loadguard-hook")
        with open(binary, "w") as f:
            f.write(WATCHER_STUB)
        os.chmod(binary, 0o755)
        self.record = os.path.join(os.path.dirname(self.t.root), "record")
        self.t.env["RECORD"] = self.record

    def start(self, status, start=2549600, data=None, **env):
        environ = dict(self.t.env, PATH=self.t.bin + ":/usr/bin:/bin", **env)
        return learn.start_watcher(status, self.data if data is None else data,
                                   root=self.t.root, environ=environ,
                                   start=start)

    def recorded(self):
        deadline = time.monotonic() + 5
        while not os.path.exists(self.record):
            self.assertLess(time.monotonic(), deadline, "watcher not run")
            time.sleep(0.02)
        with open(self.record) as f:
            lines = f.read().split("\n")
        args, pid, stat = lines[:3]
        fields = stat[stat.rindex(")") + 2:].split()
        os.waitpid(int(pid), 0)     # the hook would exit; the test reaps
        return {"args": args, "pid": int(pid), "sid": int(fields[3]),
                "fds": lines[4:7], "cwd": lines[7]}

    def test_after_attached(self):
        claude = self.reuben_session()
        self.assertEqual(self.t.confine(2549600), "attached")
        before = len(self.t.calls())
        self.assertEqual(self.start("attached"), "started")
        got = self.recorded()
        self.assertEqual(got["args"], "--watch %d" % claude)
        # Detached: its own session, stdio on /dev/null, cwd /.
        self.assertEqual(got["sid"], got["pid"])
        self.assertEqual(got["fds"], ["/dev/null"] * 3)
        self.assertEqual(got["cwd"], "/")
        # The hook sat outside the scope: the watcher is moved in.
        (attach,) = self.t.calls()[before:]
        self.assertEqual(attach[6:12], [
            "AttachProcessesToUnit", "ssau", "loadguard-091fbf8e-%d.scope"
            % claude, "", "1", str(got["pid"])])

    def test_after_already_no_move(self):
        claude = self.reuben_session()
        scope = SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % claude
        self.t.write("/proc/%d/cgroup" % claude, "0::%s\n" % scope)
        self.assertEqual(self.start("already"), "started")
        self.assertEqual(self.recorded()["args"], "--watch %d" % claude)
        self.assertEqual(self.t.calls(), [])

    def test_nested_claude_asks_for_the_scopes_owner(self):
        outer = self.reuben_session()
        scope = SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % outer
        self.t.write("/proc/%d/cgroup" % outer, "0::%s\n" % scope)
        self.t.proc(3000, outer, "bash", cgroup=scope)
        self.t.proc(3001, 3000, "claude", ["claude", "-p", "x"], cgroup=scope)
        self.t.proc(3002, 3001, "python3", cgroup=scope)
        self.assertEqual(self.start("already", start=3002), "started")
        self.assertEqual(self.recorded()["args"], "--watch %d" % outer)

    def test_not_started(self):
        claude = self.reuben_session()
        scope = SLICE_PATH + "/loadguard-091fbf8e-%d.scope" % claude
        self.t.write("/proc/%d/cgroup" % claude, "0::%s\n" % scope)
        for status in ("no-linger", "disabled", "start-failed",
                       "unconfirmed", "no-session", "stub"):
            with self.subTest(status=status):
                self.assertEqual(self.start(status), "not-confined")
        self.assertEqual(self.start("already", LOADGUARD_LEARN="0"),
                         "disabled")
        self.assertEqual(self.start("already", data=""), "no-binary")
        self.assertEqual(self.start("already", data=self.t.root),
                         "no-binary")
        os.chmod(os.path.join(self.data, "bin", "loadguard-hook"), 0o644)
        self.assertEqual(self.start("already"), "no-binary")
        self.assertFalse(os.path.exists(self.record))

    def test_session_not_in_a_scope(self):
        self.reuben_session()
        self.assertEqual(self.start("already"), "not-confined")
        self.assertFalse(os.path.exists(self.record))


# --- the CLI: learned, forget, doctor ---------------------------------------------

class CommandLine(unittest.TestCase):
    ENTRIES = [
        {"command": JSON_DATA, "peak_rss": int(3.4 * GIB), "cwd": PROJECT,
         "first_seen": "2026-09-12T22:43:40Z",
         "last_seen": "2026-09-21T05:18:28Z"},
        {"command": "cat <<'EOF' | perl\nprint 1\nEOF", "peak_rss": 700 * MIB,
         "cwd": "/tmp/ü", "first_seen": "2026-09-27T01:00:00Z",
         "last_seen": "2026-09-27T01:00:00Z"},
        {"command": "make bench"}]

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loadguard-learned-cli-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        self.path = os.path.join(self.state, "loadguard", "learned.jsonl")
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(e, ensure_ascii=False) + "\n"
                            for e in self.ENTRIES))

    def cli(self, *argv, **env):
        environ = {"PATH": os.environ["PATH"], "HOME": HOME,
                   "XDG_STATE_HOME": self.state}
        environ.update(env)
        return subprocess.run([CLI] + list(argv), capture_output=True,
                              timeout=60, env=environ, text=True)

    def test_learned(self):
        proc = self.cli("learned")
        self.assertEqual((proc.returncode, proc.stderr), (0, ""))
        self.assertEqual(proc.stdout.splitlines(), [
            "3 learned commands in %s; each exact text is heavy:" % self.path,
            "  1  3.4 GiB  last 2026-09-21  in ~/dev/p5-json-schema-modern",
            "     perl -Ilib t/json_data.t",
            "  2  700 MiB  last 2026-09-27  in /tmp/\\xfc",
            "     cat <<'EOF' | perl\\nprint 1\\nEOF",
            "  3  ? MiB  last ?",
            "     make bench"])

    def test_learned_empty_off_broken(self):
        os.unlink(self.path)
        proc = self.cli("learned")
        self.assertEqual((proc.returncode, proc.stdout),
                         (0, "no learned commands (%s)\n" % self.path))
        proc = self.cli("learned", LOADGUARD_LEARN="0")
        self.assertTrue(proc.stdout.startswith(
            "learning is off (LOADGUARD_LEARN=0): the hook ignores this "
            "list\n"), proc.stdout)
        with open(self.path, "w") as f:
            f.write("x" * ((1 << 20) + 1))
        proc = self.cli("learned")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("is larger than 1048576 bytes: the hook ignores it",
                      proc.stdout)
        proc = self.cli("learned", XDG_STATE_HOME="", HOME="relative")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("no list", proc.stdout)

    def test_forget_one(self):
        proc = self.cli("forget", "2")
        self.assertEqual((proc.returncode, proc.stdout), (
            0, "forgot: cat <<'EOF' | perl\\nprint 1\\nEOF\n"))
        entries, _ = learn.read(self.path)
        self.assertEqual(entries, [self.ENTRIES[0], self.ENTRIES[2]])
        # What is left is the hook's list: the first still matches.
        proc = run([BIN["driver"], "decide", THRASH], payload(JSON_DATA),
                   base_env(XDG_STATE_HOME=self.state))
        self.assertIn(b"learned: peaked at 3.4 GiB", proc.stdout)

    def test_forget_several_and_all(self):
        proc = self.cli("forget", "3", "1", "3")
        self.assertEqual(proc.stdout.splitlines(), [
            "forgot: perl -Ilib t/json_data.t", "forgot: make bench"])
        proc = self.cli("forget", "--all")
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(os.path.exists(self.path))
        proc = self.cli("forget", "--all")
        self.assertEqual(proc.stdout, "nothing to forget (%s)\n" % self.path)

    def test_forget_all_clears_a_broken_list(self):
        with open(self.path, "w") as f:
            f.write("x" * ((1 << 20) + 1))
        self.assertEqual(self.cli("forget", "1").returncode, 1)
        self.assertTrue(os.path.exists(self.path))
        self.assertEqual(self.cli("forget", "--all").returncode, 0)
        self.assertFalse(os.path.exists(self.path))

    def test_forget_wrong_number_changes_nothing(self):
        with open(self.path, "rb") as f:
            before = f.read()
        proc = self.cli("forget", "1", "4")
        self.assertEqual((proc.returncode, proc.stdout), (
            1, "forget: no entry 4: the list has 3; nothing changed\n"))
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), before)
        for argv in (["forget", "0"], ["forget", "x"], ["forget", "-1"],
                     ["forget", "--all", "1"], ["learned", "x"]):
            with self.subTest(argv=argv):
                proc = self.cli(*argv)
                self.assertEqual(proc.returncode, 2)
                self.assertTrue(proc.stderr.startswith("usage: loadguard"))

    def test_forget_waits_for_the_lock(self):
        # The watcher and forget share learned.lock: forget waits.
        lock = open(os.path.join(os.path.dirname(self.path), "learned.lock"),
                    "a")
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX)
        proc = subprocess.Popen(
            [CLI, "forget", "--all"], stdout=subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "XDG_STATE_HOME": self.state})
        self.addCleanup(proc.wait)
        time.sleep(0.5)
        self.assertIsNone(proc.poll())
        self.assertTrue(os.path.exists(self.path))
        fcntl.flock(lock, fcntl.LOCK_UN)
        proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(os.path.exists(self.path))

    def test_explain_through_the_cli(self):
        data = os.path.join(self.tmp, "data")
        self.assertEqual(build.ensure(ROOT, data), "built")
        proc = self.cli("explain", JSON_DATA, CLAUDE_PLUGIN_DATA=data)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith(
            "heavy:   yes (learned: peaked at 3.4 GiB RSS on 2026-09-21)\n"),
            proc.stdout)


if __name__ == "__main__":
    unittest.main()
