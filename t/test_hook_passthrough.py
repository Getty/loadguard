"""The PreToolUse entry: hooks/loadguard, a sh starter, and its wiring.

Without a built binary the starter is the whole hook and must pass every
payload through: exit 0, nothing on stdout (= no decision, normal permission
flow). With a binary it hands stdin over by exec. The compiled hook itself is
tested in test_hook_binary.py, its build in test_build.py.
"""

import json
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "loadguard")
FIXTURES = os.path.join(ROOT, "t", "fixtures")

# Wall-clock per run; only catches hangs. Far below the 5 s hook timeout.
BUDGET_S = 1.0


def fixture_names():
    return sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json"))


def read_fixture(name):
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


def run_starter(args, stdin=b"", env=None):
    env = {"PATH": os.environ["PATH"]} if env is None else env
    return subprocess.run([HOOK, *args], input=stdin, capture_output=True,
                          timeout=10, cwd=ROOT, env=env)


class StarterWithoutBinary(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = tmp.name  # exists, but holds no bin/loadguard-hook

    def test_fixtures_present(self):
        names = fixture_names()
        for required in ("bash-plain.json", "bash-heredoc.json",
                         "bash-background.json", "read-tool.json",
                         "broken.json", "empty.json"):
            self.assertIn(required, names)

    def test_every_fixture_passes_through_silently(self):
        cases = {"empty data dir": [self.data],
                 "missing data dir": [os.path.join(self.data, "nope")],
                 "empty argument": [""],
                 "no argument, no env": []}
        for case, args in cases.items():
            for name in fixture_names():
                with self.subTest(case=case, fixture=name):
                    proc = run_starter(args, read_fixture(name))
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertEqual(proc.stdout, b"")
                    self.assertEqual(proc.stderr, b"")

    def test_closed_stdin(self):
        proc = subprocess.run([HOOK, self.data], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b"")

    def test_non_executable_binary_is_ignored(self):
        os.mkdir(os.path.join(self.data, "bin"))
        path = os.path.join(self.data, "bin", "loadguard-hook")
        with open(path, "w") as f:
            f.write("#!/bin/sh\necho SHOULD-NOT-RUN\n")
        os.chmod(path, 0o644)
        proc = run_starter([self.data], read_fixture("bash-plain.json"))
        self.assertEqual((proc.returncode, proc.stdout), (0, b""))

    def test_starter_is_executable_posix_sh(self):
        self.assertTrue(os.access(HOOK, os.X_OK))
        with open(HOOK, encoding="utf-8") as f:
            self.assertEqual(f.readline(), "#!/bin/sh\n")


class StarterWithBinary(unittest.TestCase):
    """A stand-in binary echoes its stdin: the starter passes it on untouched."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = tmp.name
        os.mkdir(os.path.join(self.data, "bin"))
        path = os.path.join(self.data, "bin", "loadguard-hook")
        with open(path, "w") as f:
            f.write("#!/bin/sh\necho \"pid $$\" >&2\nexec cat\n")
        os.chmod(path, 0o755)

    def assert_handed_over(self, proc, stdin):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, stdin)

    def test_data_dir_as_argument(self):
        stdin = read_fixture("bash-heredoc.json")
        self.assert_handed_over(run_starter([self.data], stdin), stdin)

    def test_data_dir_from_environment(self):
        stdin = read_fixture("bash-plain.json")
        env = {"PATH": os.environ["PATH"], "CLAUDE_PLUGIN_DATA": self.data}
        self.assert_handed_over(run_starter([], stdin, env), stdin)

    def test_exec_keeps_the_pid(self):
        # exec, not fork: the binary runs as the starter's own process.
        proc = subprocess.Popen([HOOK, self.data], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _, err = proc.communicate(timeout=10)
        self.assertEqual(err.decode().strip(), "pid %d" % proc.pid)


class PayloadFields(unittest.TestCase):
    """Pins the field names of the documented PreToolUse payload."""

    def payload(self, name):
        return json.loads(read_fixture(name))

    def test_documented_fields_in_fixtures(self):
        for name in ("bash-plain.json", "bash-heredoc.json",
                     "bash-background.json", "bash-subagent.json"):
            with self.subTest(fixture=name):
                p = self.payload(name)
                self.assertEqual(p["hook_event_name"], "PreToolUse")
                self.assertEqual(p["tool_name"], "Bash")
                for key in ("session_id", "cwd", "tool_use_id"):
                    self.assertIsInstance(p[key], str)
                self.assertIsInstance(
                    p["tool_input"].get("run_in_background", False), bool)
        self.assertTrue(
            self.payload("bash-background.json")["tool_input"]["run_in_background"])

    def test_recorded_tool_input_holds_only_what_the_model_set(self):
        # Recorded (k7): no defaults are filled in — description, timeout and
        # run_in_background are present only if the model passed them.
        self.assertEqual(self.payload("bash-plain.json")["tool_input"],
                         {"command": "pwd"})
        self.assertEqual(self.payload("bash-background.json")["tool_input"],
                         {"command": "echo LOADGUARD_BG",
                          "run_in_background": True})


class PluginWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "hooks", "hooks.json")) as f:
            cls.hooks = json.load(f)["hooks"]

    def test_manifest(self):
        with open(os.path.join(ROOT, ".claude-plugin", "plugin.json")) as f:
            manifest = json.load(f)
        self.assertEqual(manifest["name"], "loadguard")
        self.assertIn("version", manifest)

    def test_events(self):
        self.assertEqual(sorted(self.hooks), ["PreToolUse", "SessionStart"])

    def test_pre_tool_use_runs_the_starter(self):
        (entry,) = self.hooks["PreToolUse"]
        self.assertEqual(entry["matcher"], "Bash")
        (hook,) = entry["hooks"]
        self.assertEqual(hook["type"], "command")
        # Exec form (args set): no shell between Claude Code and the starter.
        # Without args support it degrades to shell form and the starter
        # reads $CLAUDE_PLUGIN_DATA from the environment instead.
        self.assertEqual(hook["command"], "${CLAUDE_PLUGIN_ROOT}/hooks/loadguard")
        self.assertEqual(hook["args"], ["${CLAUDE_PLUGIN_DATA}"])
        self.assertNotIn("async", hook)
        # Seconds. Short, so a hang costs one Bash call at most 5 s instead of
        # the 600 s default; on timeout Claude Code drops the hook and runs
        # the command (fail open).
        self.assertLessEqual(hook["timeout"], 5)
        self.assertGreater(hook["timeout"], BUDGET_S)

    def session_start_hook(self, name):
        (entry,) = self.hooks["SessionStart"]
        self.assertNotIn("matcher", entry)
        found = [h for h in entry["hooks"]
                 if h["command"] == "${CLAUDE_PLUGIN_ROOT}/hooks/" + name]
        self.assertEqual(len(found), 1, name)
        self.assertEqual(len(entry["hooks"]), 2)
        self.assertTrue(os.access(os.path.join(ROOT, "hooks", name), os.X_OK))
        return found[0]

    def test_session_start_builds_in_the_background(self):
        hook = self.session_start_hook("loadguard-build")
        self.assertEqual(hook["args"], ["${CLAUDE_PLUGIN_DATA}"])
        self.assertIs(hook["async"], True)

    def test_session_start_confines_in_the_background(self):
        # Async: the move takes ~40 ms plus Python start; the session never
        # waits for it. Processes claude started before it are moved along.
        hook = self.session_start_hook("loadguard-confine")
        self.assertIs(hook["async"], True)
        self.assertLessEqual(hook["timeout"], 10)

if __name__ == "__main__":
    unittest.main()
