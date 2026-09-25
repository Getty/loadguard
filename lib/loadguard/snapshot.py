"""Host pressure snapshot: read it live from /proc, or parse it from an incident file.

Runs before every Bash call once the hook uses it, so: stdlib only, no
subprocess, no heavy imports (no dataclasses, glob or re — dataclasses alone
costs tens of ms to import). Every source is read independently; a missing or
unreadable file (PSI on an old kernel, no zram) leaves its fields None and
never raises.

All sizes are in bytes. PSI averages are percentages as the kernel prints them.
"""

import os


class _Value:
    """Slotted value object: equality and repr over its fields."""

    __slots__ = ()

    def __init__(self, **fields):
        for name in self.__slots__:
            setattr(self, name, fields.get(name))

    def __eq__(self, other):
        return type(self) is type(other) and all(
            getattr(self, n) == getattr(other, n) for n in self.__slots__
        )

    def __repr__(self):
        return "%s(%s)" % (
            type(self).__name__,
            ", ".join("%s=%r" % (n, getattr(self, n)) for n in self.__slots__),
        )


class PsiLine(_Value):
    """One `some` or `full` line of /proc/pressure/<resource>."""

    __slots__ = ("avg10", "avg60", "avg300", "total")


class Psi(_Value):
    """One PSI resource. `full` is None where the kernel does not report it."""

    __slots__ = ("some", "full")


class Zram(_Value):
    """All initialised zram devices, summed (bytes).

    disksize: capacity; orig_data_size: uncompressed data stored (fill);
    mem_used_total: RAM the compressed data occupies.
    """

    __slots__ = ("disksize", "orig_data_size", "mem_used_total")

    @property
    def fill(self):
        """Stored data relative to capacity, 0.0-1.0."""
        return self.orig_data_size / self.disksize


class Snapshot(_Value):
    """Host pressure at one moment. Any field may be None (source missing)."""

    __slots__ = (
        "load1", "load5", "load15",
        "mem_total", "mem_available", "swap_total", "swap_free",
        "psi_cpu", "psi_io", "psi_memory",
        "zram",
    )


_PSI_RESOURCES = ("cpu", "io", "memory")
_MEMINFO_KEYS = {
    "MemTotal": "mem_total",
    "MemAvailable": "mem_available",
    "SwapTotal": "swap_total",
    "SwapFree": "swap_free",
}


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _psi_line(line):
    """`some avg10=0.00 avg60=0.42 avg300=0.77 total=697328452` -> (kind, PsiLine)."""
    parts = line.split()
    kind, fields = parts[0], dict(p.split("=", 1) for p in parts[1:])
    return kind, PsiLine(
        avg10=float(fields["avg10"]),
        avg60=float(fields["avg60"]),
        avg300=float(fields["avg300"]),
        total=int(fields["total"]),
    )


def parse_psi(text):
    """Contents of one /proc/pressure/<resource> file -> Psi, or None."""
    if not text:
        return None
    try:
        lines = dict(_psi_line(l) for l in text.splitlines() if l.strip())
    except (ValueError, KeyError, IndexError):
        return None
    if "some" not in lines:
        return None
    return Psi(some=lines["some"], full=lines.get("full"))


def _parse_loadavg(text, snap):
    try:
        l1, l5, l15 = text.split()[:3]
        snap.load1, snap.load5, snap.load15 = float(l1), float(l5), float(l15)
    except (AttributeError, ValueError):
        pass


def _parse_meminfo(text, snap):
    if not text:
        return
    missing = len(_MEMINFO_KEYS)
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        attr = _MEMINFO_KEYS.get(key)
        if attr is None:
            continue
        try:
            setattr(snap, attr, int(rest.split()[0]) * 1024)  # kB
        except (ValueError, IndexError):
            pass
        missing -= 1
        if not missing:
            break


def read_zram(root="/"):
    """Sum over /sys/block/zram*; None if there is no initialised device."""
    block = os.path.join(root, "sys", "block")
    try:
        names = [n for n in os.listdir(block) if n.startswith("zram")]
    except OSError:
        return None
    disksize = orig = used = 0
    for name in names:
        try:
            size = int(_read(os.path.join(block, name, "disksize")))
            if not size:
                continue  # device exists but was never initialised
            mm = _read(os.path.join(block, name, "mm_stat")).split()
            disksize, orig, used = disksize + size, orig + int(mm[0]), used + int(mm[2])
        except (TypeError, ValueError, AttributeError, IndexError):
            continue
    if not disksize:
        return None
    return Zram(disksize=disksize, orig_data_size=orig, mem_used_total=used)


def read_snapshot(root="/"):
    """Read the live host state below `root` (tests point it at a fixture tree)."""
    proc = os.path.join(root, "proc")
    snap = Snapshot()
    _parse_loadavg(_read(os.path.join(proc, "loadavg")), snap)
    _parse_meminfo(_read(os.path.join(proc, "meminfo")), snap)
    for res in _PSI_RESOURCES:
        setattr(snap, "psi_" + res, parse_psi(_read(os.path.join(proc, "pressure", res))))
    snap.zram = read_zram(root)
    return snap


# --- incident files (~/load-incidents/*.txt, written by ~/bin/load-watchdog.sh)

# The watchdog writes the PSI section as
#   cat /proc/pressure/io /proc/pressure/cpu /proc/pressure/memory
# without labels, under the (misleading) title "I/O-Druck (PSI)". The order
# comes from the script, not from the file; a group starts at each `some` line.
_INCIDENT_PSI_ORDER = ("io", "cpu", "memory")
_MIB = 1024 * 1024


def _sections(text):
    sections, current = {}, None
    for line in text.splitlines():
        if line.startswith("=== ") and line.endswith(" ==="):
            current = sections.setdefault(line[4:-4], [])
        elif current is not None and line.strip():
            current.append(line)
    return sections


def _parse_free(lines, snap):
    """`free -m` output: Mem total/available and Swap total/free (MiB -> bytes)."""
    for line in lines:
        cols = line.split()
        try:
            if cols[0] == "Mem:":
                snap.mem_total = int(cols[1]) * _MIB
                snap.mem_available = int(cols[6]) * _MIB
            elif cols[0] == "Swap:":
                snap.swap_total = int(cols[1]) * _MIB
                snap.swap_free = int(cols[3]) * _MIB
        except (ValueError, IndexError):
            pass


def _parse_incident_psi(lines, snap):
    groups = []
    for line in lines:
        if line.startswith("some "):
            groups.append([line])
        elif line.startswith("full ") and groups:
            groups[-1].append(line)
    if len(groups) != len(_INCIDENT_PSI_ORDER):
        return  # a file was missing; the unlabeled order is then ambiguous
    for res, group in zip(_INCIDENT_PSI_ORDER, groups):
        setattr(snap, "psi_" + res, parse_psi("\n".join(group)))


def parse_incident(text):
    """An incident snapshot -> Snapshot. zram is always None: not recorded.

    Memory figures come from `free -m` and are MiB-granular. Swap there is the
    sum of all swap devices (on reuben: zram plus a swapfile), not zram.
    """
    sections = _sections(text)
    snap = Snapshot()
    loadavg = sections.get("loadavg")
    if loadavg:
        _parse_loadavg(loadavg[0], snap)
    _parse_free(sections.get("Speicher", ()), snap)
    _parse_incident_psi(sections.get("I/O-Druck (PSI)", ()), snap)
    return snap
