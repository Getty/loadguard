"""Parity (k22): dist/cli.js, the TS port of bin/loadguard
(lib/loadguard/cli.py), answers as the Python CLI does where it is meant to.

lib/loadguard/cli.py stays the oracle until the switch to Bun (B7). The
classes below are classes of test_cli and test_learn, run again with each
CLI call mirrored through the TS side — the formatting of status and
explain and the doctor through `dist/driver.js cli ROOT START ME ...`
against the same fixture tree, learned/forget through dist/cli.js itself —
and the two compared. The Python result is what the inherited assertions
then check.

The deliberate differences (k22), and how the comparison bridges them:
- Positional arguments only (getty-bun: no entry argument begins with
  "-"): `forget all` for `forget --all`, `help` for `-h`/`--help`;
  `explain` without a command reads it from stdin. Python's argv is
  translated before the TS run; the usage text is the new one.
- No hook binary: the report is computed in-process. status's hook line
  names the bundle (not compared); the binary's pass-through and "no report
  mode" answers do not exist (those doctor cases are not mirrored).
- doctor: the rows about the binary, its build and the C compiler are gone
  (stage 2/3 keeps its limits row), a runtime section checks the Bun and
  the getty-bun slot (TS only, dropped before the comparison), the hints
  name `loadguard forget all`, and "no watcher for this session" no longer
  mentions the hook binary.

Bun: $LOADGUARD_BUN, else `bun` on PATH; without one every test here is
skipped. Bun's caches and GETTY_HOME go to a temporary directory.
"""

import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import test_cli as tcli
import test_learn as tl
from test_parity import BUN, restore, same_files, snapshot
from test_throttle import base_env

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "lib"))
from loadguard import cli as py_cli  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVER_JS = os.path.join(ROOT, "dist", "driver.js")
CLI_JS = os.path.join(ROOT, "dist", "cli.js")
STATE = {}
HOOK_LINE = "hook:    decided in-process by "


def setUpModule():
    if BUN is None:
        raise unittest.SkipTest("no Bun ($LOADGUARD_BUN or bun on PATH): "
                                "the TS CLI goes unchecked")
    STATE["tmp"] = tempfile.mkdtemp(prefix="loadguard-parity-cli-")
    tcli.setUpModule()
    tl.setUpModule()
    STATE["usage"] = run_ts(CLI_JS, ["help"], b"", base_env()).stdout


def tearDownModule():
    tcli.tearDownModule()
    tl.tearDownModule()
    if "tmp" in STATE:
        shutil.rmtree(STATE["tmp"], ignore_errors=True)


def bun_env(env):
    """The test's environment, plus Bun's caches and the getty-bun store in
    the scratch directory."""
    env = dict(env)
    tmp = STATE["tmp"]
    env.update(BUN_INSTALL=os.path.join(tmp, "bun"),
               BUN_INSTALL_CACHE_DIR=os.path.join(tmp, "cache"),
               XDG_CACHE_HOME=os.path.join(tmp, "xdg-cache"),
               BUN_RUNTIME_TRANSPILER_CACHE_PATH="0",
               GETTY_HOME=os.path.join(tmp, "getty"))
    return env


def run_ts(entry, args, stdin, env, timeout=60):
    """A bundle as the starters run it: no project config."""
    return subprocess.run(
        [BUN, "--no-install", "--config=/dev/null", "--no-env-file", entry] +
        list(args), input=stdin, capture_output=True, timeout=timeout,
        env=bun_env(env))


def ts_argv(argv):
    """Python's argv in the positional spelling."""
    return ["all" if a == "--all" else a for a in argv]


def ts_text(text):
    """What Python prints, in the TS CLI's words."""
    return (text.replace("loadguard forget --all", "loadguard forget all")
            .replace("it starts with the session once the hook binary "
                     "exists; start a new session",
                     "it starts with the session; start a new session"))


class Mirrored:
    """Counts the mirrored calls: a class that mirrored none fails."""

    compared = 0

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        if cls.compared == 0:
            raise AssertionError("%s: no CLI call was mirrored through the "
                                 "TS side" % cls.__name__)

    def same(self, py, ts, what):
        type(self).compared += 1
        if py != ts:
            raise AssertionError("TS CLI differs from the Python CLI\n  "
                                 "call: %r\n  Python: %r\n  TS:     %r"
                                 % (what, py, ts))


# --- status and explain: the formatting on fixture trees --------------------

class Status(Mirrored, tcli.Status):
    def status(self, root,
               session="not run from a Claude Code or Codex session",
               **env):
        lines = super().status(root, session, **env)
        ts = run_ts(DRIVER_JS, ["cli", root, "1", "4242", "status"], b"",
                    base_env(**env))
        self.assertEqual((ts.returncode, ts.stderr), (0, b""))
        got = ts.stdout.decode("utf-8").split("\n")
        self.assertEqual(got[-1], "")
        self.assertTrue(got[-2].startswith(HOOK_LINE), got[-2])
        self.same(lines[:-1], got[:-2], ("status", root, env))
        return lines


class Explain(Mirrored, tcli.Explain):
    def explain(self, root, command, **env):
        lines = super().explain(root, command, **env)
        want = "\n".join(lines) + "\n"
        for how, args, stdin in (
                ("argv", ["explain", command], b""),
                ("stdin", ["explain"], command.encode("utf-8") + b"\n")):
            ts = run_ts(DRIVER_JS, ["cli", root, "1", "4242"] + args, stdin,
                        base_env(**env))
            self.assertEqual((ts.returncode, ts.stderr), (0, b""), how)
            self.same(want, ts.stdout.decode("utf-8"),
                      ("explain", how, command, env))
        return lines


# --- doctor ---------------------------------------------------------------------

def sections_of(text):
    """[(title, [row lines])] of a doctor output, and its last line."""
    lines = text.split("\n")
    assert lines[0] == "loadguard doctor" and lines[-1] == "", text
    out = []
    for line in lines[1:-2]:
        if line.startswith(" "):
            out[-1][1].append(line)
        else:
            out.append((line, []))
    return out, lines[-2]


def joined(sections):
    """The doctor output of sections, the count recomputed."""
    fails = sum(row.startswith("  FAIL") for _t, rows in sections
                for row in rows)
    return "\n".join(["loadguard doctor"] + [
        line for title, rows in sections for line in [title] + rows] +
        ["all good" if not fails else
         "%d problem%s" % (fails, "" if fails == 1 else "s")]) + "\n"


STAGE23 = "stage 2/3, refuse heavy commands: "


def python_side(out):
    """Python's doctor without what TS does not have: the binary's rows."""
    sections, _ = sections_of(out)
    keep = []
    for title, rows in sections:
        if title.startswith(STAGE23):
            rows = [r for r in rows
                    if r.startswith("  ok    limits memory PSI full ")]
        keep.append((title, rows))
    return ts_text(joined(keep))


def ts_side(out):
    """TS's doctor without what Python does not have: the runtime section."""
    sections, _ = sections_of(out)
    return joined([(t, rows) for t, rows in sections
                   if not t.startswith("runtime, ")])


class Doctor(Mirrored, tcli.Doctor):
    def doctor(self, root, environ, start=4200):
        rc, out, sections = super().doctor(root, environ, start)
        ts = run_ts(DRIVER_JS, ["cli", root, str(start), "4242", "doctor"],
                    b"", environ)
        self.assertEqual(ts.stderr, b"")
        got = ts.stdout.decode("utf-8")
        runtime = [t for t, _r in sections_of(got)[0]
                   if t.startswith("runtime, ")]
        self.assertEqual(runtime, ["runtime, Bun 1.4.5 from getty-bun: "
                                   "missing"], got)
        header = sections[1][0]
        if header in (STAGE23 + "on", STAGE23 + "off (LOADGUARD_THROTTLE=0)"):
            want = python_side(out)
            self.same(want, ts_side(got), ("doctor", environ))
            self.assertEqual(ts.returncode, 0 if want.endswith(
                "all good\n") else 1)
        else:
            # The binary is missing, stale or without report modes: TS has
            # none, its stage 2/3 answers from its own code.
            self.assertIn(STAGE23 + "on\n", got)
        return rc, out, sections


# --- learned and forget ---------------------------------------------------------

class CommandLine(Mirrored, tl.CommandLine):
    def cli(self, *argv, **env):
        environ = {"PATH": os.environ["PATH"], "HOME": tl.HOME,
                   "XDG_STATE_HOME": self.state}
        environ.update(env)
        dirs = [self.state]
        before = snapshot(dirs)
        proc = super().cli(*argv, **env)
        after_py = snapshot(dirs)
        restore(before, after_py)
        ts = run_ts(CLI_JS, ts_argv(argv), b"", environ)
        stderr = ts.stderr.decode("utf-8")
        if proc.stderr == py_cli.USAGE + "\n":
            self.assertEqual(stderr, STATE["usage"].decode("utf-8"))
            stderr = proc.stderr
        self.same((proc.returncode, ts_text(proc.stdout), proc.stderr),
                  (ts.returncode, ts.stdout.decode("utf-8"), stderr),
                  ("cli", argv, env))
        same_files(after_py, snapshot(dirs), argv)
        return proc

    def test_forget_waits_for_the_lock_ts(self):
        # The same lock as the watchers and the Python CLI.
        lock = open(os.path.join(os.path.dirname(self.path), "learned.lock"),
                    "a")
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX)
        proc = subprocess.Popen(
            [BUN, "--no-install", "--config=/dev/null", "--no-env-file",
             CLI_JS, "forget", "all"], stdout=subprocess.PIPE,
            env=bun_env({"PATH": os.environ["PATH"],
                         "XDG_STATE_HOME": self.state}))
        self.addCleanup(proc.wait)
        time.sleep(0.5)
        self.assertIsNone(proc.poll())
        self.assertTrue(os.path.exists(self.path))
        fcntl.flock(lock, fcntl.LOCK_UN)
        proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(os.path.exists(self.path))
        type(self).compared += 1


# --- the entry, end to end (TS only: test_cli.Command, adapted) ----------------

class Entry(unittest.TestCase):
    def cli(self, *argv, stdin=b"", **env):
        environ = base_env(**env)
        proc = run_ts(CLI_JS, argv, stdin, environ)
        return proc.returncode, proc.stdout.decode("utf-8"), \
            proc.stderr.decode("utf-8")

    def test_status(self):
        rc, out, err = self.cli("status")
        self.assertEqual((rc, err), (0, ""))
        labels = [line[:9].strip() for line in out.splitlines()
                  if line[:1] != " "]
        self.assertEqual(labels, ["memory:", "slots:", "heavy:", "session:",
                                  "hook:"])
        self.assertIn(HOOK_LINE + CLI_JS + ", the hook's own code\n", out)

    def test_explain(self):
        rc, out, err = self.cli("explain", "git", "status")
        self.assertEqual((rc, err), (0, ""))
        self.assertTrue(out.startswith("heavy:   no: no heavy pattern, not "
                                       "learned"))
        rc, out, _ = self.cli("explain", "cd x && prove -lr t/")
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith("heavy:   yes (prove)\n"))
        self.assertIn("\nverdict: ", out)

    def test_explain_from_stdin(self):
        # The way to a command that starts with "-": no entry argument may.
        rc, out, _ = self.cli("explain", stdin=b"prove -lr t/\n")
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith("heavy:   yes (prove)\n"))
        rc, out, _ = self.cli("explain", stdin=b"-x; make test")
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith("heavy:   yes (make test)\n"), out)

    def test_usage(self):
        for argv in ([], ["bogus"], ["status", "x"], ["explain", "-x"],
                     ["-h"], ["--help"], ["forget", "--all"],
                     ["forget", "all", "1"], ["learned", "x"]):
            with self.subTest(argv=argv):
                rc, out, err = self.cli(*argv)
                self.assertEqual((rc, out), (2, ""))
                self.assertEqual(err, STATE["usage"].decode("utf-8"))
        rc, out, _ = self.cli("explain", stdin=b"\n")
        self.assertEqual(rc, 2)
        rc, out, _ = self.cli("help")
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith("usage: loadguard status | doctor | "))
        self.assertNotRegex(out, r"(^|\s)--?[a-z]")

    def test_live_doctor(self):
        # Read-only; whatever this host is, the answer is a verdict.
        rc, out, err = self.cli("doctor", XDG_RUNTIME_DIR=os.environ.get(
            "XDG_RUNTIME_DIR", ""))
        self.assertIn(rc, (0, 1), err)
        self.assertTrue(out.startswith("loadguard doctor\nstage 1, "), out)
        self.assertIn("\nruntime, Bun 1.4.5 from getty-bun: missing\n"
                      "  ok    this runs on Bun 1.4.5, the pin, at ", out)
        self.assertIn("  --    no getty-bun slot yet at %s/runtimes/bun/"
                      "1.4.5/" % os.path.join(STATE["tmp"], "getty"), out)
        self.assertRegex(out, r"\n(all good|\d+ problems?)\n$")
        self.assertNotIn("compiler", out)



if __name__ == "__main__":
    unittest.main()
