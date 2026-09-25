"""Measurement: live snapshot reader and incident-file parser (lib/loadguard/snapshot.py).

Everything runs against fixtures in t/fixtures/ (see README there) or read-only
against ~/load-incidents. Nothing here produces load.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "lib")
sys.path.insert(0, LIB)

from loadguard.snapshot import (  # noqa: E402
    Psi, PsiLine, Snapshot, Zram, parse_incident, parse_psi, read_snapshot,
)

FIXTURES = os.path.join(ROOT, "t", "fixtures")
TREE_RECORDED = os.path.join(FIXTURES, "proc", "reuben-recorded-20260926")
TREE_THRASH = os.path.join(FIXTURES, "proc", "thrash-20260917-175030-reconstructed")
INCIDENTS = os.path.join(FIXTURES, "incidents")
LIVE_INCIDENTS = os.path.expanduser("~/load-incidents")

KIB = 1024
MIB = 1024 * 1024


def incident(name):
    with open(os.path.join(INCIDENTS, name + ".txt")) as f:
        return parse_incident(f.read())


class ReadSnapshotTest(unittest.TestCase):
    def test_recorded_tree(self):
        s = read_snapshot(TREE_RECORDED)
        self.assertEqual((s.load1, s.load5, s.load15), (10.64, 11.22, 10.58))
        self.assertEqual(s.mem_total, 8025928 * KIB)
        self.assertEqual(s.mem_available, 2469728 * KIB)
        self.assertEqual(s.swap_total, 11598972 * KIB)
        self.assertEqual(s.swap_free, 4565948 * KIB)
        self.assertEqual(
            s.psi_memory,
            Psi(some=PsiLine(avg10=0.31, avg60=0.43, avg300=0.68, total=697916932),
                full=PsiLine(avg10=0.0, avg60=0.0, avg300=0.04, total=423276985)),
        )
        self.assertEqual(s.psi_cpu.some.avg10, 86.44)
        self.assertEqual(s.psi_cpu.full.total, 0)
        self.assertEqual(s.psi_io.full.total, 1420702123)
        self.assertEqual(
            s.zram,
            Zram(disksize=3287420928, orig_data_size=3218501632,
                 mem_used_total=1159520256),
        )
        self.assertAlmostEqual(s.zram.fill, 0.979, places=3)

    def test_reconstructed_tree_matches_its_incident(self):
        # The thrash tree was built from the incident's own numbers; reading
        # it live must yield exactly what the parser gets from the excerpt.
        self.assertEqual(read_snapshot(TREE_THRASH), incident("20260917-175030"))

    def test_empty_root_is_all_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(read_snapshot(d), Snapshot())

    def test_nonexistent_root_is_all_none(self):
        self.assertEqual(read_snapshot("/nonexistent/loadguard-root"), Snapshot())

    def copy_tree(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        tree = os.path.join(d, "root")
        shutil.copytree(TREE_RECORDED, tree)
        return tree

    def test_no_psi_old_kernel(self):
        tree = self.copy_tree()
        shutil.rmtree(os.path.join(tree, "proc", "pressure"))
        s = read_snapshot(tree)
        self.assertIsNone(s.psi_cpu)
        self.assertIsNone(s.psi_io)
        self.assertIsNone(s.psi_memory)
        self.assertEqual(s.mem_total, 8025928 * KIB)
        self.assertIsNotNone(s.zram)

    def test_cpu_psi_without_full_line(self):
        # Kernels before 5.13 print only `some` for cpu.
        tree = self.copy_tree()
        with open(os.path.join(tree, "proc", "pressure", "cpu"), "w") as f:
            f.write("some avg10=1.00 avg60=2.00 avg300=3.00 total=4\n")
        s = read_snapshot(tree)
        self.assertEqual(s.psi_cpu, Psi(some=PsiLine(avg10=1.0, avg60=2.0, avg300=3.0, total=4), full=None))

    def test_no_zram(self):
        tree = self.copy_tree()
        shutil.rmtree(os.path.join(tree, "sys"))
        s = read_snapshot(tree)
        self.assertIsNone(s.zram)
        self.assertEqual(s.load1, 10.64)

    def test_uninitialised_zram_is_ignored(self):
        tree = self.copy_tree()
        z1 = os.path.join(tree, "sys", "block", "zram1")
        os.makedirs(z1)
        with open(os.path.join(z1, "disksize"), "w") as f:
            f.write("0\n")
        self.assertEqual(read_snapshot(tree).zram.disksize, 3287420928)

    def test_zram_devices_are_summed(self):
        tree = self.copy_tree()
        shutil.copytree(os.path.join(tree, "sys", "block", "zram0"),
                        os.path.join(tree, "sys", "block", "zram1"))
        z = read_snapshot(tree).zram
        self.assertEqual(z.disksize, 2 * 3287420928)
        self.assertEqual(z.orig_data_size, 2 * 3218501632)

    def test_garbage_files_give_none(self):
        tree = self.copy_tree()
        for rel in ("proc/loadavg", "proc/meminfo", "proc/pressure/memory",
                    "sys/block/zram0/mm_stat"):
            with open(os.path.join(tree, rel), "w") as f:
                f.write("garbage\n")
        s = read_snapshot(tree)
        self.assertIsNone(s.load1)
        self.assertIsNone(s.mem_total)
        self.assertIsNone(s.psi_memory)
        self.assertIsNone(s.zram)
        self.assertIsNotNone(s.psi_io)

    def test_partial_meminfo(self):
        tree = self.copy_tree()
        with open(os.path.join(tree, "proc", "meminfo"), "w") as f:
            f.write("MemTotal:        8025928 kB\nMemFree:  1 kB\n")
        s = read_snapshot(tree)
        self.assertEqual(s.mem_total, 8025928 * KIB)
        self.assertIsNone(s.mem_available)
        self.assertIsNone(s.swap_free)

    def test_parse_psi_rejects_missing_some(self):
        self.assertIsNone(parse_psi("full avg10=1.00 avg60=0 avg300=0 total=0\n"))
        self.assertIsNone(parse_psi(""))
        self.assertIsNone(parse_psi(None))

    @unittest.skipUnless(os.path.isdir("/proc/self"), "no /proc on this host")
    def test_live_host_does_not_raise(self):
        # Reads /proc and /sys of this host once — cheap, no load produced.
        self.assertIsInstance(read_snapshot("/"), Snapshot)

    def test_cheap(self):
        n = 200
        start = time.perf_counter()
        for _ in range(n):
            read_snapshot(TREE_RECORDED)
        mean_ms = (time.perf_counter() - start) / n * 1000
        # Measured well under 1 ms; the bound only catches gross regressions
        # on a loaded host.
        self.assertLess(mean_ms, 5.0)

    def test_import_pulls_in_nothing_heavy(self):
        code = (
            "import sys; before = set(sys.modules); sys.path.insert(0, %r); "
            "import loadguard.snapshot; "
            "print(' '.join(sorted(set(sys.modules) - before)))" % LIB
        )
        out = subprocess.run([sys.executable, "-c", code], capture_output=True,
                             text=True, check=True).stdout.split()
        self.assertEqual(sorted(out), ["loadguard", "loadguard.snapshot"])


class ParseIncidentTest(unittest.TestCase):
    def test_calm_cpu_bound(self):
        s = incident("20260925-225204")
        self.assertEqual((s.load1, s.load5, s.load15), (20.03, 18.52, 12.42))
        self.assertEqual(s.mem_total, 7837 * MIB)
        self.assertEqual(s.mem_available, 1944 * MIB)
        self.assertEqual((s.swap_total, s.swap_free), (11327 * MIB, 5316 * MIB))
        self.assertEqual(s.psi_cpu.some, PsiLine(avg10=95.30, avg60=95.50, avg300=92.03, total=13637204325))
        self.assertEqual(s.psi_cpu.full, PsiLine(avg10=0.0, avg60=0.0, avg300=0.0, total=0))
        self.assertEqual(s.psi_io.some.avg10, 0.09)
        self.assertEqual(s.psi_memory, Psi(
            some=PsiLine(avg10=0.00, avg60=0.07, avg300=0.73, total=627989010),
            full=PsiLine(avg10=0.00, avg60=0.00, avg300=0.05, total=413603875)))
        self.assertIsNone(s.zram)

    def test_tipping(self):
        s = incident("20260926-011126")
        self.assertEqual((s.load1, s.load5, s.load15), (35.72, 32.20, 23.46))
        self.assertEqual(s.mem_available, 1279 * MIB)
        self.assertEqual((s.swap_total, s.swap_free), (11327 * MIB, 4123 * MIB))
        self.assertEqual(s.psi_memory, Psi(
            some=PsiLine(avg10=10.42, avg60=6.10, avg300=3.66, total=691463010),
            full=PsiLine(avg10=0.74, avg60=0.35, avg300=0.20, total=422601491)))
        self.assertEqual(s.psi_io.some.avg10, 1.72)
        self.assertEqual(s.psi_cpu.some.avg10, 96.30)

    def test_thrash(self):
        s = incident("20260917-175030")
        self.assertEqual((s.load1, s.load5, s.load15), (20.16, 5.87, 2.25))
        self.assertEqual(s.mem_available, 1338 * MIB)
        self.assertEqual((s.swap_total, s.swap_free), (11327 * MIB, 0))
        self.assertEqual(s.psi_memory, Psi(
            some=PsiLine(avg10=63.49, avg60=54.11, avg300=19.81, total=304210881),
            full=PsiLine(avg10=59.94, avg60=51.47, avg300=18.91, total=268031340)))
        self.assertEqual(s.psi_io, Psi(
            some=PsiLine(avg10=99.18, avg60=79.66, avg300=29.43, total=944580607),
            full=PsiLine(avg10=78.66, avg60=68.33, avg300=26.02, total=826256606)))
        self.assertEqual(s.psi_cpu.some.avg10, 4.66)

    def test_missing_psi_group_leaves_psi_none(self):
        # One pressure file absent: the unlabeled order is ambiguous, so the
        # parser must not guess which resource the remaining lines belong to.
        text = ("=== loadavg ===\n1.00 2.00 3.00 1/1 1\n\n"
                "=== I/O-Druck (PSI) ===\n"
                "some avg10=1.00 avg60=0 avg300=0 total=1\n"
                "some avg10=2.00 avg60=0 avg300=0 total=2\n")
        s = parse_incident(text)
        self.assertEqual(s.load1, 1.0)
        self.assertIsNone(s.psi_io)
        self.assertIsNone(s.psi_cpu)
        self.assertIsNone(s.psi_memory)

    def test_empty_text(self):
        self.assertEqual(parse_incident(""), Snapshot())

    @unittest.skipUnless(os.path.isdir(LIVE_INCIDENTS),
                         "~/load-incidents not present on this host")
    def test_all_live_incidents_parse(self):
        # Read-only; nothing from there is copied into the repo.
        names = sorted(n for n in os.listdir(LIVE_INCIDENTS) if n.endswith(".txt"))
        self.assertTrue(names)
        for name in names:
            with self.subTest(incident=name):
                with open(os.path.join(LIVE_INCIDENTS, name), errors="replace") as f:
                    s = parse_incident(f.read())
                # The watchdog only fires at load1 >= 20 and always records
                # free -m and all three PSI files.
                self.assertGreaterEqual(s.load1, 20.0)
                self.assertIsNotNone(s.mem_total)
                self.assertIsNotNone(s.mem_available)
                self.assertIsNotNone(s.swap_total)
                for psi in (s.psi_io, s.psi_cpu, s.psi_memory):
                    self.assertIsNotNone(psi)
                    self.assertIsNotNone(psi.full)


if __name__ == "__main__":
    unittest.main()
