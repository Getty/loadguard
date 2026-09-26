"""The compiled hook, src/loadguard-hook.c.

setUpClass builds two binaries into a temporary directory:
  hook    the production main, flags FLAGS + -Werror
  driver  -DLOADGUARD_TEST, flags TEST_FLAGS (-Werror, ASan, UBSan): exposes
          the payload extraction
Without a C compiler every test here is skipped, with the reason.
"""

import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
FIXTURES = os.path.join(ROOT, "t", "fixtures")
UPDATED = os.path.join(FIXTURES, "updated-input")
STARTER = os.path.join(ROOT, "hooks", "loadguard")

from loadguard import build  # noqa: E402

VALID = ("bash-plain.json", "bash-heredoc.json", "bash-background.json",
         "bash-subagent.json", "bash-no-command.json", "read-tool.json",
         "not-an-object.json", "empty.json")
INVALID = ("broken.json", "invalid-utf8.json")

# A command with everything the extraction must carry over byte for byte.
NASTY = ("cd '/tmp/a b' && cat <<'EOF' > \"out file\"\n"
         "'single' \"double\" `backtick` $HOME ${X:-y} \\ \\\\ \\n \\\"\n"
         "EOF\n"
         "printf '%s\\n' \"ü € 😀 \u2028 \u00a0\" | sed 's/\\t/ /g'; "
         "echo \x01\x1b[31m\x7f\t\r done; (exit 3) || true")


def read_fixture(name, where=FIXTURES):
    with open(os.path.join(where, name), "rb") as f:
        return f.read()


def bash_payload(tool_input, ensure_ascii=True):
    payload = {"session_id": "s", "hook_event_name": "PreToolUse",
               "tool_name": "Bash", "tool_input": tool_input,
               "tool_use_id": "toolu_x"}
    return json.dumps(payload, ensure_ascii=ensure_ascii).encode("utf-8")


class Binary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cc = build.find_cc()
        if cc is None:
            raise unittest.SkipTest("no C compiler (cc/gcc/$CC) on PATH")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.hook = os.path.join(cls.tmp.name, "bin", build.BINARY)
        cls.driver = os.path.join(cls.tmp.name, "driver")
        for out, flags, defines in (
                (cls.hook, build.FLAGS + ("-Werror",), ()),
                (cls.driver, build.TEST_FLAGS, ("-DLOADGUARD_TEST",))):
            ok, output = build.compile_hook(ROOT, cc, out, flags, defines)
            if not ok:
                cls.tmp.cleanup()
                raise AssertionError("build of %s failed:\n%s" % (out, output))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_bin(self, argv, stdin=b""):
        return subprocess.run(argv, input=stdin, capture_output=True,
                              timeout=30)


class PassThrough(Binary):
    def assert_passes(self, proc, quiet=True):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, b"")
        if quiet:
            self.assertEqual(proc.stderr, b"")
        else:
            self.assertIn(b"loadguard: pass-through (", proc.stderr)

    def test_every_fixture(self):
        names = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json"))
        self.assertEqual(sorted(VALID + INVALID), names)
        for name in names:
            with self.subTest(fixture=name):
                proc = self.run_bin([self.hook], read_fixture(name))
                self.assert_passes(proc, quiet=name in VALID)

    def test_recorded_k7_payloads(self):
        for name in ("probe-a.pre.json", "probe-c.pre.json"):
            with self.subTest(fixture=name):
                self.assert_passes(
                    self.run_bin([self.hook], read_fixture(name, UPDATED)))

    def test_through_the_starter(self):
        data = os.path.dirname(os.path.dirname(self.hook))
        for name in VALID + INVALID:
            with self.subTest(fixture=name):
                proc = self.run_bin([STARTER, data], read_fixture(name))
                self.assert_passes(proc, quiet=name in VALID)

    def test_empty_and_blank_stdin(self):
        for stdin in (b"", b" \n\t\r\n"):
            with self.subTest(stdin=stdin):
                self.assert_passes(self.run_bin([self.hook], stdin))
        proc = subprocess.run([self.hook], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=10)
        self.assert_passes(proc)

    def test_broken_json(self):
        for stdin in (b"{", b"{\"tool_name\": \"Bash\",}", b"nul",
                      b"{\"a\": 1} trailing", b"{\"a\": 1}{\"b\": 2}",
                      b"{\"a\": \"x\x00y\"}", b"{\"a\": 1}\x00",
                      b"{\"a\": \"\\ud800\"}", b"\xff{}",
                      b"[" * 5000 + b"]" * 5000):
            with self.subTest(stdin=stdin[:40]):
                self.assert_passes(self.run_bin([self.hook], stdin),
                                   quiet=False)

    def test_huge_stdin(self):
        # Above the 8 MiB limit: drained, not parsed, passed through.
        huge = bash_payload({"command": "x" * (9 << 20)})
        proc = self.run_bin([self.hook], huge)
        self.assert_passes(proc, quiet=False)
        self.assertIn(b"too large", proc.stderr)
        # Just below the limit: parsed as usual, silently.
        big = bash_payload({"command": "x" * ((8 << 20) - 200)})
        self.assertLess(len(big), 8 << 20)
        self.assert_passes(self.run_bin([self.hook], big))

    def test_no_fork_or_exec_in_the_source(self):
        with open(os.path.join(ROOT, build.HOOK_SOURCE), encoding="utf-8") as f:
            source = f.read()
        for forbidden in ("fork(", "execv", "execl", "system(", "popen(",
                          "posix_spawn"):
            self.assertNotIn(forbidden, source)

    def test_runtime(self):
        # Target < 30 ms per Bash call. Measures process start to exit as
        # Claude Code sees it, for the largest recorded payload.
        stdin = read_fixture("bash-heredoc.json")
        times = []
        for _ in range(200):
            start = time.perf_counter()
            self.run_bin([self.hook], stdin)
            times.append((time.perf_counter() - start) * 1000)
        times.sort()
        median, p90 = statistics.median(times), times[int(len(times) * 0.9)]
        sys.stderr.write("[hook runtime n=200: median %.2f ms, p90 %.2f ms] "
                         % (median, p90))
        self.assertLess(median, 30)


class Extraction(Binary):
    def command(self, stdin):
        return self.run_bin([self.driver, "command"], stdin)

    def test_bash_command_extracted(self):
        self.assertEqual(self.command(read_fixture("bash-plain.json")).stdout,
                         b"pwd")
        heredoc = self.command(read_fixture("bash-heredoc.json"))
        self.assertEqual(heredoc.returncode, 0)
        self.assertEqual(
            heredoc.stdout.decode("utf-8"),
            json.loads(read_fixture("bash-heredoc.json"))["tool_input"]["command"])

    def test_nasty_command_extracted_verbatim(self):
        for ensure_ascii in (True, False):
            with self.subTest(ensure_ascii=ensure_ascii):
                proc = self.command(bash_payload({"command": NASTY}, ensure_ascii))
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(proc.stdout.decode("utf-8"), NASTY)

    def test_not_a_bash_command(self):
        for stdin in [read_fixture(n) for n in (
                "read-tool.json", "bash-no-command.json", "not-an-object.json",
                "broken.json", "invalid-utf8.json", "empty.json")] + [
                bash_payload(None), bash_payload({"command": 7}),
                b'{"tool_name": "bash", "tool_input": {"command": "ls"}}']:
            with self.subTest(stdin=stdin[:60]):
                proc = self.command(stdin)
                self.assertEqual((proc.returncode, proc.stdout), (1, b""),
                                 proc.stderr)


if __name__ == "__main__":
    unittest.main()
