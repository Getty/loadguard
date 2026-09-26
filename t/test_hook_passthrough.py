"""The PreToolUse entry: hooks/loadguard, a sh starter, and its wiring.

Without a built binary the starter is the whole hook and must pass every
payload through: exit 0, nothing on stdout (= no decision, normal permission
flow). With a binary it hands stdin over by exec. The compiled hook itself is
tested in test_hook_binary.py, its build in test_build.py.
"""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "loadguard")
FIXTURES = os.path.join(ROOT, "t", "fixtures")
EVENTS = os.path.join(FIXTURES, "events")
CODEX = os.path.join(FIXTURES, "codex")

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

    def test_event_payloads_pass_through_silently(self):
        # UserPromptSubmit and SessionStart (k6): no binary, no context.
        for name in sorted(os.listdir(EVENTS)):
            with self.subTest(fixture=name):
                with open(os.path.join(EVENTS, name), "rb") as f:
                    proc = run_starter([self.data], f.read())
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))

    def test_codex_payloads_pass_through_silently(self):
        # k11: no binary, no decision and no context under Codex either.
        for name in sorted(os.listdir(CODEX)):
            with self.subTest(fixture=name):
                with open(os.path.join(CODEX, name), "rb") as f:
                    proc = run_starter([self.data], f.read())
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))

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

    def test_context_event_fixtures(self):
        # Reconstructed from the docs' examples (k6); the event name is all
        # the hook reads of them. No tool_name: the Bash path never applies.
        for name, event in (("user-prompt-submit.json", "UserPromptSubmit"),
                            ("session-start.json", "SessionStart")):
            with self.subTest(fixture=name):
                with open(os.path.join(EVENTS, name), "rb") as f:
                    p = json.load(f)
                self.assertEqual(p["hook_event_name"], event)
                self.assertNotIn("tool_name", p)
                self.assertIsInstance(p["session_id"], str)

    def test_codex_fixtures(self):
        # Reconstructed from codex-rs 0.153.4 hooks/src/schema.rs, fields in
        # serialization order: PreToolUseCommandInput (278-296; agent_id and
        # agent_type only in a spawned subagent), UserPromptSubmitCommandInput
        # (567-583), SessionStartCommandInput (499-510). The shell tool's
        # tool_input is {"command": …} alone (exec_command.rs:504-515).
        tool = ["session_id", "turn_id", "transcript_path", "cwd",
                "hook_event_name", "model", "permission_mode", "tool_name",
                "tool_input", "tool_use_id"]
        for name, keys, event in (
                ("pre-tool-use.json", tool, "PreToolUse"),
                ("pre-tool-use-subagent.json",
                 tool[:2] + ["agent_id", "agent_type"] + tool[2:],
                 "PreToolUse"),
                ("user-prompt-submit.json",
                 ["session_id", "turn_id", "transcript_path", "cwd",
                  "hook_event_name", "model", "permission_mode", "prompt"],
                 "UserPromptSubmit"),
                ("session-start.json",
                 ["session_id", "transcript_path", "cwd", "hook_event_name",
                  "model", "permission_mode", "source"], "SessionStart")):
            with self.subTest(fixture=name):
                with open(os.path.join(CODEX, name), "rb") as f:
                    p = json.load(f)
                self.assertEqual(list(p), keys)
                self.assertEqual(p["hook_event_name"], event)
                if event == "PreToolUse":
                    self.assertEqual(p["tool_name"], "Bash")
                    self.assertEqual(list(p["tool_input"]), ["command"])
        self.assertEqual(sorted(os.listdir(CODEX)), [
            "pre-tool-use-subagent.json", "pre-tool-use.json",
            "session-start.json", "user-prompt-submit.json"])

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

    def test_codex_manifest_matches(self):
        # k11: one release, two manifests. Every field of Claude Code's has
        # the same value in Codex's, so a version bump in one alone fails
        # here. Codex's adds `hooks` only (like ~/dev/briefing's; codex-rs
        # core-plugins/src/manifest.rs RawPluginManifest), and no skills:
        # loadguard ships none.
        manifests = {}
        for harness in ("claude", "codex"):
            with open(os.path.join(ROOT, ".%s-plugin" % harness,
                                   "plugin.json")) as f:
                manifests[harness] = json.load(f)
        claude, codex = manifests["claude"], manifests["codex"]
        self.assertEqual({k: codex.get(k) for k in claude}, claude)
        self.assertEqual(sorted(set(codex) - set(claude)), ["hooks"])
        self.assertEqual(codex["hooks"], "./hooks/hooks.json")

    def test_hooks_json_reads_under_codex(self):
        # Codex parses the same file (config/src/hook_config.rs): the top
        # level denies unknown fields (HooksFile, 10-17), events are its
        # names (36-61), a handler knows type/command/timeout/async/
        # statusMessage/additionalContextLimit and ignores the rest —
        # Claude Code's exec-form `args` included (161-185; no
        # deny_unknown_fields there). Its default timeout is 600 s
        # (hooks/src/engine/discovery.rs:762): every hook sets one.
        with open(os.path.join(ROOT, "hooks", "hooks.json")) as f:
            doc = json.load(f)
        self.assertLessEqual(set(doc), {"description", "hooks"})
        self.assertLessEqual(set(doc["hooks"]), {
            "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact",
            "PostCompact", "SessionStart", "SessionEnd", "UserPromptSubmit",
            "SubagentStart", "SubagentStop", "Stop", "Interrupt"})
        for event, groups in doc["hooks"].items():
            for group in groups:
                self.assertLessEqual(set(group), {"matcher", "hooks"})
                for hook in group["hooks"]:
                    with self.subTest(event=event, command=hook["command"]):
                        self.assertLessEqual(set(hook), {
                            "type", "command", "timeout", "async", "args"})
                        self.assertEqual(hook["type"], "command")
                        self.assertIsInstance(hook["timeout"], int)

    def test_events(self):
        self.assertEqual(sorted(self.hooks),
                         ["PreToolUse", "SessionStart", "UserPromptSubmit"])

    def test_hooks_json_unchanged(self):
        # Codex asks the user to trust the hooks again whenever hooks.json
        # changes (codex-rs hooks/src/engine/discovery.rs:676-725): k15 added
        # the watcher without touching it. Change it only on purpose, then
        # update this hash (the file as of k6).
        with open(os.path.join(ROOT, "hooks", "hooks.json"), "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(),
                             "d2e0dc4f9bfa7548a4cace9cf90b82ad7c52bcc408bce8e9"
                             "8314eac3a1ac663b")

    def assert_starter(self, hook):
        self.assertEqual(hook["type"], "command")
        # Exec form (args set): no shell between Claude Code and the starter.
        # Without args support it degrades to shell form and the starter
        # reads $CLAUDE_PLUGIN_DATA from the environment instead.
        self.assertEqual(hook["command"], "${CLAUDE_PLUGIN_ROOT}/hooks/loadguard")
        self.assertEqual(hook["args"], ["${CLAUDE_PLUGIN_DATA}"])
        # Synchronous: an async hook's decision has no effect, and its
        # context arrives a turn late (-p kills it at teardown).
        self.assertNotIn("async", hook)
        # Seconds. Short, so a hang costs one Bash call or one prompt at most
        # 5 s instead of the 600 s (30 s on UserPromptSubmit) default; on
        # timeout Claude Code drops the hook's output and goes on (fail open).
        self.assertLessEqual(hook["timeout"], 5)
        self.assertGreater(hook["timeout"], BUDGET_S)

    def test_pre_tool_use_runs_the_starter(self):
        (entry,) = self.hooks["PreToolUse"]
        self.assertEqual(entry["matcher"], "Bash")
        (hook,) = entry["hooks"]
        self.assert_starter(hook)

    def test_user_prompt_submit_runs_the_starter(self):
        # Stage 4 (k6): the context line, only under memory pressure.
        # UserPromptSubmit takes no matcher.
        (entry,) = self.hooks["UserPromptSubmit"]
        self.assertEqual(list(entry), ["hooks"])
        (hook,) = entry["hooks"]
        self.assert_starter(hook)

    def test_session_start_runs_the_starter(self):
        # Stage 4 (k6), the same line at session start (any source).
        self.assert_starter(self.session_start_hook("loadguard"))

    def session_start_hook(self, name):
        (entry,) = self.hooks["SessionStart"]
        self.assertNotIn("matcher", entry)
        found = [h for h in entry["hooks"]
                 if h["command"] == "${CLAUDE_PLUGIN_ROOT}/hooks/" + name]
        self.assertEqual(len(found), 1, name)
        self.assertEqual(len(entry["hooks"]), 3)
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

class CodexRuns(unittest.TestCase):
    """Every hooks.json entry, run the way Codex 0.153.4 runs it (k11).

    Codex drops `args` (see test_hooks_json_reads_under_codex), replaces
    ${PLUGIN_ROOT}, ${CLAUDE_PLUGIN_ROOT}, ${PLUGIN_DATA} and
    ${CLAUDE_PLUGIN_DATA} in the command text, sets the same four in the
    environment (hooks/src/engine/discovery.rs:262-270, 566-568) and runs
    `<shell> -c <command>` (core/src/session/mod.rs:4666;
    hooks/src/engine/command_runner.rs:390-426). So each entry has to find
    the data directory in $CLAUDE_PLUGIN_DATA alone.

    The plugin root is a copy of hooks/ with a stub lib/loadguard that
    records what it was called with: nothing is built or confined, and the
    real claude above the test run is never touched.
    """

    STUB_BUILD = (
        "import os\n"
        "def ensure(root, data_dir):\n"
        "    with open(os.path.join(data_dir, 'built'), 'w') as f:\n"
        "        f.write(root + '\\n' + data_dir)\n"
        "    return 'built'\n")
    STUB_CONFINE = (
        "import os\n"
        "def confine(session_id):\n"
        "    with open(os.path.join(os.environ['CLAUDE_PLUGIN_DATA'], "
        "'confined'), 'w') as f:\n"
        "        f.write(str(session_id))\n"
        "    return 'stub'\n")
    # k15: the watcher's start gets confine's status and the data dir, which
    # the confine entry (no args) reads from $CLAUDE_PLUGIN_DATA.
    STUB_LEARN = (
        "import os\n"
        "def start_watcher(status, data_dir):\n"
        "    with open(os.path.join(data_dir, 'watched'), 'w') as f:\n"
        "        f.write(status)\n"
        "    return 'stub'\n")

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = os.path.join(tmp.name, "plugins", "cache", "getty",
                                 "loadguard", "0.1.1")
        self.data = os.path.join(tmp.name, "plugins", "data",
                                 "loadguard-getty")
        shutil.copytree(os.path.join(ROOT, "hooks"),
                        os.path.join(self.root, "hooks"))
        lib = os.path.join(self.root, "lib", "loadguard")
        os.makedirs(lib)
        for name, text in (("__init__.py", ""), ("build.py", self.STUB_BUILD),
                           ("confine.py", self.STUB_CONFINE),
                           ("learn.py", self.STUB_LEARN)):
            with open(os.path.join(lib, name), "w") as f:
                f.write(text)
        # A stand-in hook binary that echoes its stdin.
        os.makedirs(os.path.join(self.data, "bin"))
        binary = os.path.join(self.data, "bin", "loadguard-hook")
        with open(binary, "w") as f:
            f.write("#!/bin/sh\nexec cat\n")
        os.chmod(binary, 0o755)
        with open(os.path.join(ROOT, "hooks", "hooks.json")) as f:
            self.hooks = json.load(f)["hooks"]

    def codex_run(self, hook, stdin):
        env = {"PATH": os.environ["PATH"]}
        for key, value in (("PLUGIN_ROOT", self.root),
                           ("PLUGIN_DATA", self.data)):
            env[key] = env["CLAUDE_" + key] = value
        command = hook["command"]
        for key, value in env.items():
            command = command.replace("${%s}" % key, value)
        return subprocess.run(["/bin/sh", "-c", command], input=stdin,
                              capture_output=True, timeout=10, env=env,
                              cwd=self.data)

    def payload(self, name):
        with open(os.path.join(CODEX, name), "rb") as f:
            return f.read()

    def entries(self):
        for event, groups in sorted(self.hooks.items()):
            for group in groups:
                for hook in group["hooks"]:
                    yield event, hook["command"].rsplit("/", 1)[1], hook

    def test_every_entry(self):
        fixtures = {"PreToolUse": "pre-tool-use.json",
                    "UserPromptSubmit": "user-prompt-submit.json",
                    "SessionStart": "session-start.json"}
        seen = set()
        for event, name, hook in self.entries():
            with self.subTest(event=event, hook=name):
                stdin = self.payload(fixtures[event])
                proc = self.codex_run(hook, stdin)
                self.assertEqual((proc.returncode, proc.stderr), (0, b""))
                seen.add(name)
                if name == "loadguard":
                    # The starter reached the binary through the env.
                    self.assertEqual(proc.stdout, stdin)
                    continue
                self.assertEqual(proc.stdout, b"")
                marker = os.path.join(self.data, {
                    "loadguard-build": "built",
                    "loadguard-confine": "confined"}[name])
                # The build runs detached: wait for it, at most 5 s.
                deadline = time.monotonic() + 5
                while not os.path.exists(marker):
                    self.assertLess(time.monotonic(), deadline, name)
                    time.sleep(0.02)
                with open(marker) as f:
                    got = f.read()
                os.remove(marker)
                if name == "loadguard-build":
                    self.assertEqual(got, self.root + "\n" + self.data)
                else:
                    self.assertEqual(got, json.loads(stdin)["session_id"])
                    watched = os.path.join(self.data, "watched")
                    with open(watched) as f:
                        self.assertEqual(f.read(), "stub")
                    os.remove(watched)
        self.assertEqual(seen, {"loadguard", "loadguard-build",
                                "loadguard-confine"})


if __name__ == "__main__":
    unittest.main()
