"""bin/loadguard (k5): status, doctor, explain.

setUpModule builds two binaries into a temporary directory:
  driver  -DLOADGUARD_TEST (TEST_FLAGS): `report ROOT` and `explain ROOT`
          print what --report and --explain print, against a fixture root
  data/   a plugin data directory as the SessionStart build leaves it:
          bin/loadguard-hook (production, FLAGS) with its stamp
Formatting is tested on the driver's reports for the fixture trees of
t/test_throttle.py. The production binary only reads the live host, and
only through its report modes. Doctor's stage 1 checks run against a fixture
tree for /proc, /sys and /var/lib/systemd/linger. Without a C compiler every
test is skipped.
"""

import contextlib
import io
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "lib"))
sys.path.insert(0, HERE)
CLI = os.path.join(ROOT, "bin", "loadguard")

from loadguard import build, cli  # noqa: E402
from test_throttle import (CALM, HOME, SLICE_CGROUP, THRASH,  # noqa: E402
                           add_process, add_scenario, base_env, payload)

BIN = {}
UID = os.getuid()
USER = pwd.getpwuid(UID).pw_name
SCOPE = "loadguard-00000000-9000.scope"
UNCONFINED = "0::/user.slice/user-1000.slice/session-3.scope"


def setUpModule():
    cc = build.find_cc()
    if cc is None:
        raise unittest.SkipTest("no C compiler (cc/gcc/$CC) on PATH")
    tmp = tempfile.mkdtemp(prefix="loadguard-cli-")
    BIN["tmp"] = tmp
    BIN["driver"] = os.path.join(tmp, "driver")
    ok, output = build.compile_hook(ROOT, cc, BIN["driver"], build.TEST_FLAGS,
                                    ("-DLOADGUARD_TEST",))
    if not ok:
        raise AssertionError("build of the driver failed:\n" + output)
    BIN["data"] = os.path.join(tmp, "data")
    status = build.ensure(ROOT, BIN["data"])
    if status != "built":
        raise AssertionError("build of the hook: " + status)


def tearDownModule():
    if "tmp" in BIN:
        shutil.rmtree(BIN["tmp"], ignore_errors=True)


def write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


class Case(unittest.TestCase):
    def tmpdir(self):
        d = tempfile.mkdtemp(prefix="loadguard-cli-t-")
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def tree(self, pressure=None, scenarios=()):
        root = os.path.join(self.tmpdir(), "root")
        if pressure is None:
            os.makedirs(os.path.join(root, "proc"))
        else:
            shutil.copytree(pressure, root, symlinks=True)
        for name in scenarios:
            add_scenario(root, name)
        return root

    def driver(self, mode, root, stdin=b"{}", **env):
        proc = subprocess.run([BIN["driver"], mode, root], input=stdin,
                              capture_output=True, timeout=30,
                              env=base_env(**env))
        self.assertEqual((proc.returncode, proc.stderr), (0, b""))
        return json.loads(proc.stdout)

    def run_cli(self, *argv, **env):
        environ = {"PATH": os.environ["PATH"], "HOME": HOME}
        environ.update(env)
        return subprocess.run([CLI] + list(argv), capture_output=True,
                              timeout=60, env=environ, text=True)


# --- formatting the reports --------------------------------------------------

class Status(Case):
    def status(self, root, session="not run from a Claude Code session",
               **env):
        doc = self.driver("report", root, **env)
        return cli.format_status(doc, env, session, "/x/loadguard-hook (t)")

    def test_calm(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain"])
        self.assertEqual(self.status(root, LOADGUARD_HEAVY_SLOTS="2"), [
            "memory:  PSI full 0.00% (limit 10%), some 0.31%; swap 60% used "
            "(limit 90%); zram 97% full",
            "slots:   1/2 heavy busy",
            "         prove -lr t/ in ~/dev/sunriser",
            "heavy:   a heavy command would run now",
            "session: not run from a Claude Code session",
            "hook:    /x/loadguard-hook (t)"])

    def test_slots_full(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion", "claude-p",
                                "claude-p-prove", "npm-title"])
        lines = self.status(root, LOADGUARD_HEAVY_SLOTS="4")
        self.assertEqual(lines[1:6], [
            "slots:   4/4 heavy busy",
            "         prove -lr t/ in ~/dev/sunriser",
            "         prove -l t/foo.t in ~/dev/sunriser",
            "         make test in ~/dev/p5-foo",
            "         +1 more"])
        self.assertEqual(lines[6], "heavy:   a heavy command would be "
                                   "refused now (all heavy slots busy)")

    def test_thrash(self):
        lines = self.status(self.tree(THRASH, ["prove-chain"]))
        self.assertEqual(lines[:4], [
            "memory:  PSI full 59.94% (limit 10%), some 63.49%; swap 100% "
            "used (limit 90%)",
            "slots:   not scanned: under memory pressure the hook reads no "
            "other",
            "         process (that can stall on swap); pressure alone "
            "refuses",
            "heavy:   a heavy command would be refused now (memory "
            "pressure)"])

    def test_missing_figures(self):
        lines = self.status(self.tree())
        self.assertEqual(lines[0], "memory:  PSI full n/a (limit 10%), some "
                                   "n/a; swap n/a used (limit 90%)")
        self.assertEqual(lines[1], "slots:   0/%d heavy busy"
                         % max(1, len(os.sched_getaffinity(0)) // 2))

    def test_throttle_off_and_ignored(self):
        lines = self.status(self.tree(THRASH), LOADGUARD_THROTTLE="0",
                            LOADGUARD_PSI_FULL="5.5")
        self.assertIn("heavy:   never refused: LOADGUARD_THROTTLE=0", lines)
        self.assertIn("ignored: LOADGUARD_PSI_FULL='5.5' is not valid: the "
                      "default applies", lines)
        lines = self.status(self.tree(CALM), LOADGUARD_THROTTLE="off")
        self.assertIn("ignored: LOADGUARD_THROTTLE='off' changes nothing: "
                      "only 0 turns it off", lines)


class Explain(Case):
    def explain(self, root, command, **env):
        doc = self.driver("explain", root, payload(command), **env)
        return cli.format_explain(doc, env)

    def test_light(self):
        self.assertEqual(self.explain(self.tree(THRASH), "git status"), [
            "heavy:   no: a light command is never refused; the hook reads "
            "nothing for it",
            "verdict: allow: the hook stays silent, the command runs"])

    def test_heavy_allowed(self):
        root = self.tree(CALM, ["idle-sessions"])
        self.assertEqual(self.explain(root, "prove -lr t/",
                                      LOADGUARD_HEAVY_SLOTS="2"), [
            "heavy:   yes (prove)",
            "memory:  PSI full 0.00% (limit 10%), some 0.31%; swap 60% used "
            "(limit 90%); zram 97% full",
            "slots:   0/2 heavy busy",
            "verdict: allow: the hook stays silent, the command runs"])

    def test_denied_shows_the_reason_verbatim(self):
        root = self.tree(CALM, ["idle-sessions", "prove-chain",
                                "make-recursion"])
        proc = subprocess.run([BIN["driver"], "decide", root],
                              input=payload("dzil test"), capture_output=True,
                              env=base_env(LOADGUARD_HEAVY_SLOTS="2"))
        reason = json.loads(proc.stdout)["hookSpecificOutput"][
            "permissionDecisionReason"]
        lines = self.explain(root, "dzil test", LOADGUARD_HEAVY_SLOTS="2")
        self.assertEqual(lines[-3:], ["verdict: deny; the model is told:"] +
                         [" " * 9 + line for line in reason.split("\n")])
        self.assertEqual(lines[2:5], [
            "slots:   2/2 heavy busy",
            "         prove -lr t/ in ~/dev/sunriser",
            "         make test in ~/dev/p5-foo"])

    def test_throttle_off(self):
        self.assertEqual(self.explain(self.tree(THRASH), "prove",
                                      LOADGUARD_THROTTLE="0"), [
            "heavy:   not checked: LOADGUARD_THROTTLE=0",
            "verdict: allow: the hook stays silent, the command runs"])

    def test_not_a_bash_payload(self):
        doc = self.driver("explain", self.tree(), b"{}")
        self.assertEqual(cli.format_explain(doc, {}), [
            "verdict: allow: not a Bash payload the hook can read; it passes "
            "it through"])


# --- which binary ------------------------------------------------------------

class FindBinary(Case):
    def test_claude_plugin_data_wins(self):
        self.assertEqual(cli.find_data_dir("/x/plugins/cache/m/loadguard/1",
                                           {"CLAUDE_PLUGIN_DATA": "/d"}),
                         ("/d", "$CLAUDE_PLUGIN_DATA"))

    def test_installed_copy(self):
        # plugins/cache/<marketplace>/<plugin>/<version> -> plugins/data/<id>,
        # id <plugin>@<marketplace> with [^A-Za-z0-9_-] as "-".
        for market, data in (("getty", "loadguard-getty"),
                             ("my.market", "loadguard-my-market")):
            with self.subTest(market=market):
                self.assertEqual(
                    cli.find_data_dir("/h/.claude/plugins/cache/%s/loadguard/"
                                      "0.2.0" % market, {"HOME": "/h"}),
                    ("/h/.claude/plugins/data/" + data,
                     "installed as loadguard@" + market))

    def test_checkout(self):
        d = self.tmpdir()
        checkout, home = os.path.join(d, "co"), os.path.join(d, "home")
        env = {"HOME": home}
        self.assertEqual(cli.find_data_dir(checkout, env),
                         (os.path.join(checkout, "build"),
                          "checkout, built by make"))
        inline = os.path.join(home, ".claude", "plugins", "data",
                              "loadguard-inline")
        write(cli.binary_in(inline), "")
        self.assertEqual(cli.find_data_dir(checkout, env),
                         (inline, "--plugin-dir session, loadguard@inline"))
        other = os.path.join(d, "plugins")
        write(cli.binary_in(os.path.join(other, "data", "loadguard-inline")),
              "")
        self.assertEqual(cli.find_data_dir(
            checkout, dict(env, CLAUDE_CODE_PLUGIN_CACHE_DIR=other))[0],
            os.path.join(other, "data", "loadguard-inline"))
        write(cli.binary_in(os.path.join(checkout, "build")), "")
        self.assertEqual(cli.find_data_dir(checkout, env)[0],
                         os.path.join(checkout, "build"))


# --- the command, end to end -------------------------------------------------

def old_binary(data_dir, output=""):
    """A hook binary without report modes: it reads stdin like a hook."""
    write(cli.binary_in(data_dir),
          "#!/bin/sh\ncat >/dev/null\nprintf '%%s' '%s'\n" % output, 0o755)


class Command(Case):
    def test_status(self):
        proc = self.run_cli("status", CLAUDE_PLUGIN_DATA=BIN["data"])
        self.assertEqual((proc.returncode, proc.stderr), (0, ""))
        labels = [line[:9].strip() for line in proc.stdout.splitlines()
                  if line[:1] != " "]
        self.assertEqual(labels, ["memory:", "slots:", "heavy:", "session:",
                                  "hook:"])
        self.assertIn("hook:    %s ($CLAUDE_PLUGIN_DATA)"
                      % cli.binary_in(BIN["data"]), proc.stdout)

    def test_explain(self):
        proc = self.run_cli("explain", "git", "status",
                            CLAUDE_PLUGIN_DATA=BIN["data"])
        self.assertEqual((proc.returncode, proc.stderr), (0, ""))
        self.assertTrue(proc.stdout.startswith("heavy:   no: a light"))
        proc = self.run_cli("explain", "cd x && prove -lr t/",
                            CLAUDE_PLUGIN_DATA=BIN["data"])
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith("heavy:   yes (prove)\n"))
        self.assertIn("\nverdict: ", proc.stdout)

    def test_no_binary_is_pass_through(self):
        empty = self.tmpdir()
        binary = cli.binary_in(empty)
        proc = self.run_cli("status", CLAUDE_PLUGIN_DATA=empty)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith(
            "hook:    pass-through, nothing is refused now: no binary at %s "
            "($CLAUDE_PLUGIN_DATA)\n" % binary), proc.stdout)
        self.assertIn("\nsession: ", proc.stdout)
        proc = self.run_cli("explain", "prove", CLAUDE_PLUGIN_DATA=empty)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith(
            "verdict: allow: pass-through, nothing is refused now: no hook "
            "binary at " + binary), proc.stdout)

    def test_binary_without_report_mode(self):
        # Silent like 0.1.1, or a deny like a k4 build under pressure.
        deny = json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "x"}})
        for output in ("", deny):
            data = self.tmpdir()
            old_binary(data, output)
            for argv in (["status"], ["explain", "prove"]):
                with self.subTest(output=output[:10], argv=argv):
                    proc = self.run_cli(*argv, CLAUDE_PLUGIN_DATA=data)
                    self.assertEqual(proc.returncode, 1)
                    self.assertIn("has no report mode", proc.stdout)

    def test_usage(self):
        for argv in ([], ["bogus"], ["explain"], ["status", "x"]):
            with self.subTest(argv=argv):
                proc = self.run_cli(*argv)
                self.assertEqual((proc.returncode, proc.stdout), (2, ""))
                self.assertTrue(proc.stderr.startswith("usage: loadguard"))
        proc = self.run_cli("--help")
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(proc.stdout.startswith("usage: loadguard"))

    def test_executable(self):
        self.assertTrue(os.stat(CLI).st_mode & stat.S_IXUSR)


# --- doctor ------------------------------------------------------------------

class Doctor(Case):
    """Stage 1 against a fixture host; stage 2/3 against BIN["data"]."""

    def host(self, cgroup="0::/user.slice/user-1000.slice/user@1000.service/"
             "app.slice/app-loadguard.slice/" + SCOPE,
             controllers="cpu memory pids", linger=True, bus=True, **env):
        d = self.tmpdir()
        root = os.path.join(d, "root")
        write(os.path.join(root, "proc/sys/kernel/random/boot_id"), "b1\n")
        write(os.path.join(root, "proc/meminfo"), "MemTotal: 8025928 kB\n")
        # claude (4100) -> the Bash tool's shell (4200) -> this CLI (4242)
        for pid, ppid, comm in ((4100, 1, "claude"), (4200, 4100, "bash"),
                                (4242, 4200, "python3")):
            add_process(root, pid, ppid, comm, [comm], cgroup, HOME)
            write(os.path.join(root, "proc", str(pid), "comm"), comm + "\n")
        write(root + "/sys/fs/cgroup/user.slice/user-%d.slice/"
              "user@%d.service/cgroup.controllers" % (UID, UID),
              controllers + "\n")
        if linger:
            write(os.path.join(root, "var/lib/systemd/linger", USER), "")
        run = os.path.join(d, "run")
        os.makedirs(run)
        if bus:
            write(os.path.join(run, "bus"), "")
        fakebin = os.path.join(d, "fakebin")
        write(os.path.join(fakebin, "busctl"), "#!/bin/sh\nexit 1\n", 0o755)
        environ = {"PATH": fakebin + ":" + os.environ["PATH"], "HOME": HOME,
                   "XDG_RUNTIME_DIR": run, "CLAUDE_PLUGIN_DATA": BIN["data"]}
        environ.update(env)
        return root, environ

    def doctor(self, root, environ, start=4200):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.doctor(ROOT, environ, proc_root=root, uid=UID, me=4242,
                            start=start)
        sections = cli.doctor_sections(ROOT, environ, proc_root=root,
                                       uid=UID, me=4242, start=start)
        return rc, out.getvalue(), sections

    def test_all_good(self):
        rc, out, sections = self.doctor(*self.host())
        self.assertEqual(rc, 0, out)
        self.assertEqual([title for title, _rows in sections], [
            "stage 1, confine sessions: on",
            "stage 2/3, refuse heavy commands: on"])
        self.assertNotIn("FAIL", out)
        self.assertIn("  ok    limits MemoryHigh 2.3 GiB, MemoryMax 3.1 GiB, "
                      "MemorySwapMax 783 MiB, CPUWeight 50\n", out)
        self.assertIn("  ok    this session: confined in %s\n" % SCOPE, out)
        self.assertIn("  ok    linger for %s\n" % USER, out)
        self.assertIn("  ok    built from these sources with ", out)
        self.assertTrue(out.endswith("all good\n"))

    def test_stage1_problems(self):
        for name, kwargs, fail in (
                ("no linger", {"linger": False}, "no linger for " + USER),
                ("no delegation", {"controllers": "cpu pids"},
                 "memory controller not delegated to user@%d.service" % UID),
                ("no bus", {"bus": False},
                 "no user bus ($XDG_RUNTIME_DIR/bus)"),
                ("no cgroup v2", {"cgroup": "1:name=systemd:/x"},
                 "no cgroup v2")):
            with self.subTest(name):
                rc, out, _ = self.doctor(*self.host(**kwargs))
                self.assertEqual(rc, 1, out)
                self.assertIn("  FAIL  %s\n" % fail, out)
                self.assertIn("stage 1, confine sessions: cannot work here\n",
                              out)

    def test_unconfined_session(self):
        rc, out, _ = self.doctor(*self.host(cgroup=UNCONFINED))
        self.assertEqual(rc, 1)
        self.assertIn("  FAIL  this session: not confined (cgroup %s)\n"
                      % UNCONFINED[3:], out)
        self.assertIn("-> sessions are confined when they start", out)

    def test_not_in_a_session(self):
        rc, out, _ = self.doctor(*self.host(), start=1)
        self.assertEqual(rc, 0, out)
        self.assertIn("  --    this session: not run from a Claude Code "
                      "session\n", out)

    def test_switched_off(self):
        root, environ = self.host(linger=False, cgroup=UNCONFINED,
                                  LOADGUARD_CONFINE="0",
                                  LOADGUARD_THROTTLE="0")
        rc, out, sections = self.doctor(root, environ)
        self.assertEqual(rc, 0, out)
        self.assertEqual([title for title, _rows in sections], [
            "stage 1, confine sessions: off (LOADGUARD_CONFINE=0)",
            "stage 2/3, refuse heavy commands: off (LOADGUARD_THROTTLE=0)"])
        self.assertIn("  --    no linger for " + USER, out)

    def test_ignored_variables(self):
        rc, out, sections = self.doctor(*self.host(
            LOADGUARD_PSI_FULL="5.5", LOADGUARD_THROTTLE="off",
            LOADGUARD_CONFINE="no", LOADGUARD_MEMORY_MAX="abc"))
        self.assertEqual(rc, 1)
        self.assertEqual(sections[-1], ("environment", [
            ("FAIL", "LOADGUARD_THROTTLE='off' changes nothing: only 0 turns "
             "it off", None),
            ("FAIL", "LOADGUARD_PSI_FULL='5.5' is not valid: the default "
             "applies", None),
            ("FAIL", "LOADGUARD_CONFINE='no' changes nothing: only 0 turns "
             "it off", None),
            ("FAIL", "LOADGUARD_MEMORY_MAX='abc' is not valid: the default "
             "applies", None)]))
        self.assertTrue(out.endswith("4 problems\n"))

    def test_no_binary(self):
        empty = self.tmpdir()
        rc, out, sections = self.doctor(*self.host(CLAUDE_PLUGIN_DATA=empty))
        self.assertEqual(rc, 1)
        self.assertEqual(sections[1][0],
                         "stage 2/3, refuse heavy commands: pass-through")
        self.assertIn("  FAIL  no hook binary at %s ($CLAUDE_PLUGIN_DATA): "
                      "every Bash command passes through\n"
                      % cli.binary_in(empty), out)
        self.assertIn("-> built at the next session start; now: python3 %s "
                      "--foreground %s\n" % (os.path.join(
                          ROOT, "hooks", "loadguard-build"), empty), out)

    def test_stale_binary(self):
        data = os.path.join(self.tmpdir(), "data")
        shutil.copytree(BIN["data"], data)
        write(cli.binary_in(data) + ".stamp", "0" * 64 + "\n")
        rc, out, _ = self.doctor(*self.host(CLAUDE_PLUGIN_DATA=data))
        self.assertEqual(rc, 1)
        self.assertIn("  FAIL  stale: built from other sources, flags or "
                      "compiler\n", out)

    def test_binary_without_report_mode(self):
        data = self.tmpdir()
        old_binary(data)
        rc, out, sections = self.doctor(*self.host(CLAUDE_PLUGIN_DATA=data))
        self.assertEqual(rc, 1)
        self.assertEqual(sections[1][0],
                         "stage 2/3, refuse heavy commands: unknown")
        self.assertIn("has no report mode", out)

    def test_no_compiler(self):
        root, environ = self.host()
        environ["PATH"] = environ["PATH"].split(":")[0]     # busctl only
        rc, out, _ = self.doctor(root, environ)
        self.assertEqual(rc, 0, out)
        self.assertIn("  --    no C compiler ($CC, cc, gcc): the binary "
                      "cannot be checked against these sources or rebuilt\n",
                      out)

    def test_live_host(self):
        # Read-only; whatever this host is, the answer is a verdict.
        proc = self.run_cli("doctor", CLAUDE_PLUGIN_DATA=BIN["data"],
                            XDG_RUNTIME_DIR=os.environ.get(
                                "XDG_RUNTIME_DIR", ""))
        self.assertIn(proc.returncode, (0, 1), proc.stderr)
        self.assertTrue(proc.stdout.startswith("loadguard doctor\nstage 1, "),
                        proc.stdout)
        self.assertRegex(proc.stdout, r"\n(all good|\d+ problems?)\n$")


if __name__ == "__main__":
    unittest.main()
