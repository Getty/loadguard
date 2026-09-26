"""Stage 0: the PreToolUse hook is a fail-open pass-through.

Feeds every fixture in t/fixtures/ to hooks/loadguard as a subprocess, the way
Claude Code runs it, and asserts: exit 0, nothing on stdout (= no decision,
normal permission flow), within a generous wall-clock budget.
"""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "loadguard")
FIXTURES = os.path.join(ROOT, "t", "fixtures")

# Wall-clock per hook run, Python startup included. The design target is
# < 30 ms of hook work; interpreter startup alone measured 35-140 ms on
# reuben under load 5-9, so this only catches hangs and gross regressions.
# Must stay far below the 5 s timeout in hooks/hooks.json.
BUDGET_S = 1.0


def fixture_names():
    return sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json"))


def run_hook(stdin_bytes):
    start = time.perf_counter()
    proc = subprocess.run(
        [HOOK], input=stdin_bytes, capture_output=True, timeout=10, cwd=ROOT
    )
    return proc, time.perf_counter() - start


def load_hook_module():
    loader = importlib.machinery.SourceFileLoader("loadguard_hook", HOOK)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    saved, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        loader.exec_module(module)  # no __pycache__ inside hooks/
    finally:
        sys.dont_write_bytecode = saved
    return module


class HookPassThrough(unittest.TestCase):
    def test_fixtures_present(self):
        names = fixture_names()
        for required in ("bash-plain.json", "bash-heredoc.json",
                         "bash-background.json", "read-tool.json",
                         "broken.json", "empty.json"):
            self.assertIn(required, names)

    def test_every_fixture_passes_through_silently(self):
        for name in fixture_names():
            with self.subTest(fixture=name):
                with open(os.path.join(FIXTURES, name), "rb") as f:
                    proc, elapsed = run_hook(f.read())
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(proc.stdout, b"")
                self.assertLess(elapsed, BUDGET_S)

    def test_closed_stdin(self):
        proc = subprocess.run([HOOK], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b"")

    def test_errors_are_reported_on_stderr_only(self):
        with open(os.path.join(FIXTURES, "broken.json"), "rb") as f:
            proc, _ = run_hook(f.read())
        self.assertEqual(proc.stdout, b"")
        self.assertIn(b"loadguard: pass-through", proc.stderr)

    def test_valid_payloads_are_quiet_on_stderr(self):
        for name in ("bash-plain.json", "bash-heredoc.json", "read-tool.json"):
            with self.subTest(fixture=name):
                with open(os.path.join(FIXTURES, name), "rb") as f:
                    proc, _ = run_hook(f.read())
                self.assertEqual(proc.stderr, b"")

    def test_hook_is_executable(self):
        self.assertTrue(os.access(HOOK, os.X_OK))

    def test_hook_spawns_no_subprocess(self):
        with open(HOOK, encoding="utf-8") as f:
            source = f.read()
        for forbidden in ("subprocess", "os.system", "os.popen", "os.exec",
                          "os.spawn", "os.fork"):
            self.assertNotIn(forbidden, source)


class PayloadFields(unittest.TestCase):
    """Pins the field names read from the documented PreToolUse payload."""

    @classmethod
    def setUpClass(cls):
        cls.hook = load_hook_module()

    def payload(self, name):
        with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
            return json.load(f)

    def test_bash_command_extracted(self):
        self.assertEqual(self.hook.bash_command(self.payload("bash-plain.json")),
                         "pwd")
        heredoc = self.hook.bash_command(self.payload("bash-heredoc.json"))
        self.assertIn("<<'EOF'\n", heredoc)
        self.assertIn('"double"', heredoc)

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

    def test_non_bash_and_malformed_yield_none(self):
        self.assertIsNone(self.hook.bash_command(self.payload("read-tool.json")))
        self.assertIsNone(self.hook.bash_command(self.payload("bash-no-command.json")))
        self.assertIsNone(self.hook.bash_command(["Bash", "ls"]))
        self.assertIsNone(self.hook.bash_command({"tool_name": "Bash",
                                                  "tool_input": None}))


class PluginWiring(unittest.TestCase):
    def test_manifest(self):
        with open(os.path.join(ROOT, ".claude-plugin", "plugin.json")) as f:
            manifest = json.load(f)
        self.assertEqual(manifest["name"], "loadguard")
        self.assertIn("version", manifest)

    def test_hooks_json(self):
        with open(os.path.join(ROOT, "hooks", "hooks.json")) as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(list(hooks), ["PreToolUse"])
        (entry,) = hooks["PreToolUse"]
        self.assertEqual(entry["matcher"], "Bash")
        (hook,) = entry["hooks"]
        self.assertEqual(hook["type"], "command")
        self.assertEqual(hook["command"], "${CLAUDE_PLUGIN_ROOT}/hooks/loadguard")
        # Seconds. Short, so a hang costs one Bash call at most 5 s instead of
        # the 600 s default; on timeout Claude Code drops the hook and runs
        # the command (fail open).
        self.assertLessEqual(hook["timeout"], 5)
        self.assertGreater(hook["timeout"], BUDGET_S)


if __name__ == "__main__":
    unittest.main()
