"""The bun:test suite leaves no scratch directory behind (k28).

ts/test/helpers.ts is one module shared by every test file, so a cleanup
registered there runs after the first file only; each file that makes
scratch must call afterAll(cleanup). Checked twice: statically for every
file, and by running two scratch-making files (the second is the one the
old cleanup missed) with a private TMPDIR that must end up empty.

Bun: $LOADGUARD_BUN, else `bun` on PATH; without one the run is skipped.
"""

import glob
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "ts", "test")
BUN = os.environ.get("LOADGUARD_BUN") or shutil.which("bun")


class Scratch(unittest.TestCase):
    def test_every_file_cleans_up(self):
        for path in sorted(glob.glob(os.path.join(TESTS, "*.test.ts"))):
            with open(path, encoding="utf-8") as f:
                text = f.read()
            if re.search(r"\b(tempDir|tree)\(", text):
                self.assertTrue("afterAll(cleanup);" in text,
                                os.path.basename(path) + " makes scratch"
                                " but never runs afterAll(cleanup)")

    @unittest.skipIf(BUN is None, "no Bun ($LOADGUARD_BUN or bun on PATH)")
    def test_run_leaves_nothing(self):
        tmp = tempfile.mkdtemp(prefix="loadguard-scratch-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        scratch = os.path.join(tmp, "tmp")
        os.mkdir(scratch)
        env = dict(os.environ, TMPDIR=scratch,
                   BUN_INSTALL=os.path.join(tmp, "bun"),
                   BUN_INSTALL_CACHE_DIR=os.path.join(tmp, "cache"),
                   XDG_CACHE_HOME=os.path.join(tmp, "xdg-cache"),
                   BUN_RUNTIME_TRANSPILER_CACHE_PATH="0")
        r = subprocess.run(
            [BUN, "test", "./ts/test/cli.test.ts", "./ts/test/decide.test.ts"],
            cwd=ROOT, env=env, capture_output=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr.decode(errors="replace"))
        self.assertEqual(os.listdir(scratch), [])


if __name__ == "__main__":
    unittest.main()
