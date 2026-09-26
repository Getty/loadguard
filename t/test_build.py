"""Building the hook on the target host: lib/loadguard/build.py, hooks/loadguard-build.

The staleness logic runs against a stand-in compiler (a sh script that logs
each call and writes a dummy binary), so it costs no real compile. One test
builds for real with the host's compiler, if there is one.
"""

import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
ENTRY = os.path.join(ROOT, "hooks", "loadguard-build")

from loadguard import build  # noqa: E402

FAKE_CC = """#!/bin/sh
echo "$*" >> "${0%/*}/calls"
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then printf '#!/bin/sh\\nexit 0\\n' > "$2"; exit 0; fi
  shift
done
exit 1
"""
FAILING_CC = """#!/bin/sh
echo "$*" >> "${0%/*}/calls"
echo "loadguard-hook.c:1: error: boom" >&2
exit 1
"""


class Staleness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.root = os.path.join(self.tmp, "plugin")
        for rel in build.SOURCES:
            os.makedirs(os.path.join(self.root, os.path.dirname(rel)),
                        exist_ok=True)
            shutil.copy(os.path.join(ROOT, rel), os.path.join(self.root, rel))
        self.data = os.path.join(self.tmp, "data")
        self.ccdir = os.path.join(self.tmp, "ccbin")
        os.mkdir(self.ccdir)
        self.cc = os.path.join(self.ccdir, "cc")
        self.set_cc(FAKE_CC)
        self.env = {"PATH": self.ccdir}
        self.binary = os.path.join(self.data, "bin", build.BINARY)

    def set_cc(self, script):
        with open(self.cc, "w") as f:
            f.write(script)
        os.chmod(self.cc, 0o755)

    def calls(self):
        try:
            with open(os.path.join(self.ccdir, "calls")) as f:
                return len(f.readlines())
        except FileNotFoundError:
            return 0

    def ensure(self):
        return build.ensure(self.root, self.data, self.env)

    def touch_later(self, path):
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))

    def test_no_compiler_does_nothing(self):
        os.unlink(self.cc)
        self.assertEqual(self.ensure(), "no-compiler")
        self.assertFalse(os.path.exists(self.data))

    def test_cc_from_environment(self):
        self.env = {"PATH": "", "CC": self.cc}
        self.assertEqual(self.ensure(), "built")
        self.env = {"PATH": "", "CC": "no-such-cc"}
        self.assertEqual(self.ensure(), "no-compiler")

    def test_build_once_then_current(self):
        self.assertEqual(self.ensure(), "built")
        self.assertTrue(os.access(self.binary, os.X_OK))
        self.assertEqual(self.ensure(), "current")
        self.assertEqual(self.calls(), 1)
        with open(os.path.join(self.data, "build.log")) as f:
            self.assertTrue(f.read().startswith("built with " + self.cc))

    def test_rebuild_when_a_source_changes(self):
        self.assertEqual(self.ensure(), "built")
        for rel in build.SOURCES:
            with self.subTest(source=rel):
                with open(os.path.join(self.root, rel), "a") as f:
                    f.write("\n/* changed */\n")
                self.assertEqual(self.ensure(), "built")
                self.assertEqual(self.ensure(), "current")
        self.assertEqual(self.calls(), 1 + len(build.SOURCES))

    def test_same_sources_with_newer_mtime_stay_current(self):
        # A plugin update that only copies files does not rebuild.
        self.assertEqual(self.ensure(), "built")
        for rel in build.SOURCES:
            self.touch_later(os.path.join(self.root, rel))
        self.assertEqual(self.ensure(), "current")

    def test_rebuild_when_the_compiler_changes(self):
        self.assertEqual(self.ensure(), "built")
        self.touch_later(self.cc)
        self.assertEqual(self.ensure(), "built")
        self.assertEqual(self.calls(), 2)

    def test_rebuild_when_the_binary_is_gone(self):
        self.assertEqual(self.ensure(), "built")
        os.unlink(self.binary)
        self.assertEqual(self.ensure(), "built")

    def test_failed_build_removes_the_stale_binary(self):
        # Design: build failed -> no binary -> pass-through, not the old logic.
        self.assertEqual(self.ensure(), "built")
        with open(os.path.join(self.root, build.HOOK_SOURCE), "a") as f:
            f.write("\n/* changed */\n")
        self.set_cc(FAILING_CC)
        self.assertEqual(self.ensure(), "failed")
        self.assertFalse(os.path.exists(self.binary))
        self.assertFalse(os.path.exists(self.binary + ".stamp"))
        self.assertEqual(os.listdir(os.path.join(self.data, "bin")),
                         [".build.lock"])  # no temp files left
        with open(os.path.join(self.data, "build.log")) as f:
            self.assertIn("error: boom", f.read())

    def test_busy_while_another_build_holds_the_lock(self):
        os.makedirs(os.path.join(self.data, "bin"))
        with open(os.path.join(self.data, "bin", ".build.lock"), "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.ensure(), "busy")
        self.assertEqual(self.calls(), 0)
        self.assertEqual(self.ensure(), "built")

    def test_compiler_timeout(self):
        self.set_cc("#!/bin/sh\nexec sleep 30\n")
        ok, output = build.compile_hook(self.root, self.cc, self.binary,
                                        timeout=0.5)
        self.assertFalse(ok)
        self.assertIn("TimeoutExpired", output)
        self.assertEqual(os.listdir(os.path.dirname(self.binary)), [])


class Entry(unittest.TestCase):
    """hooks/loadguard-build as the SessionStart hook runs it."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = os.path.join(tmp.name, "data")
        self.ccdir = os.path.join(tmp.name, "ccbin")
        os.mkdir(self.ccdir)
        with open(os.path.join(self.ccdir, "cc"), "w") as f:
            f.write(FAKE_CC)
        os.chmod(os.path.join(self.ccdir, "cc"), 0o755)

    def run_entry(self, args, path):
        start = time.perf_counter()
        proc = subprocess.run([sys.executable, ENTRY, *args],
                              input=b'{"hook_event_name": "SessionStart"}',
                              capture_output=True, timeout=30,
                              env={"PATH": path})
        return proc, time.perf_counter() - start

    def test_detaches_and_builds(self):
        proc, _ = self.run_entry([self.data], self.ccdir)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (0, b"", b""))
        stamp = os.path.join(self.data, "bin", build.BINARY + ".stamp")
        deadline = time.monotonic() + 20
        while not os.path.exists(stamp) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(os.path.exists(stamp), "detached build never finished")

    def test_no_compiler(self):
        empty = os.path.join(self.data + "-empty-path")
        os.mkdir(empty)
        proc, _ = self.run_entry(["--foreground", self.data], empty)
        self.assertEqual((proc.returncode, proc.stdout), (0, b"no-compiler\n"))
        proc, _ = self.run_entry([self.data], empty)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (0, b"", b""))

    def test_no_data_dir(self):
        for args in ([], [""]):
            with self.subTest(args=args):
                proc, _ = self.run_entry(args, self.ccdir)
                self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                                 (0, b"", b""))
        self.assertFalse(os.path.exists(os.path.join(self.ccdir, "calls")))

    def test_real_compiler(self):
        cc = build.find_cc()
        if cc is None:
            self.skipTest("no C compiler (cc/gcc/$CC) on PATH")
        path = os.path.dirname(cc)
        proc, _ = self.run_entry(["--foreground", self.data], path)
        self.assertEqual((proc.returncode, proc.stdout), (0, b"built\n"),
                         proc.stderr)
        proc, _ = self.run_entry(["--foreground", self.data], path)
        self.assertEqual(proc.stdout, b"current\n")
        hook = os.path.join(self.data, "bin", build.BINARY)
        proc = subprocess.run([hook], input=b'{"tool_name": "Bash"}',
                              capture_output=True, timeout=10)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (0, b"", b""))


if __name__ == "__main__":
    unittest.main()
