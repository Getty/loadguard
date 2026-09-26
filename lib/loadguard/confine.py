"""Stage 1: move the claude session into a transient systemd user scope (k3).

Called once per SessionStart from hooks/loadguard-confine. The claude process
goes into app-loadguard.slice/loadguard-<session>-<pid>.scope with memory and
CPU limits; everything it starts later inherits the scope. Commands are never
rewritten.

The calls go through `busctl --user call`: no D-Bus wire protocol
reimplemented here. busctl ships with systemd, and without systemd there is
nothing to attach to.

- StartTransientUnit with PIDs= holding claude alone (k12). systemd checks the
  PIDs, answers the call, and moves them later: a PID that vanished meanwhile
  fails the whole unit (Result=resources) while busctl still returns 0. The
  other SessionStart hooks run as claude's children at the same moment and
  exit within milliseconds, so only claude, an ancestor of this hook and
  alive for sure, goes into PIDs=.
- Once /proc shows claude in the scope, the descendants it started before
  (MCP servers, the other hooks) are moved with AttachProcessesToUnit, which
  is synchronous and needs Delegate=yes. One gone PID fails a batch without
  moving anything, so a failed batch is repeated one PID at a time, and a
  PID that fails alone is left where it is.
- No second StartTransientUnit: with claude alone nothing in the call races,
  and what is left (bus, properties, systemd refusing) fails the same way
  again. A retry would also need a new name, as the failed unit keeps its
  name ("already loaded") until systemd collects it.

Rules:
- The claude process is the nearest ancestor of the hook whose comm or argv[0]
  is `claude` — looked up in /proc, never assumed to be the parent.
- Already in any loadguard-*.scope: nothing happens. That makes SessionStart
  on resume/clear/compact a no-op and keeps a `claude -p` started from a
  confined session inside its parent's scope; moving it out would let it
  escape the limit.
- No linger for the user: nothing happens. Without linger the user manager,
  and with it the scope, stops at the last logout, taking along a claude
  that was meant to outlive it in screen/tmux.
- LOADGUARD_CONFINE=0: nothing happens. Only the exact value "0" is off;
  anything else, typos included, keeps the protective default.
- Everything that is not clearly fine (no cgroup v2, no memory controller
  delegated to user@UID.service, no bus socket, no busctl, any error) leaves
  the session where it is.

`root` prefixes /proc and /sys so tests point the code at a fixture tree; it
is "" in production.
"""

import os
import pwd
import re
import shutil
import subprocess
import time

SLICE = "app-loadguard.slice"
PREFIX = "loadguard-"

# Percent of MemTotal, CPU weight 1..10000 (systemd default 100).
DEFAULTS = (("MemoryHigh", "LOADGUARD_MEMORY_HIGH", 30, 1, 100),
            ("MemoryMax", "LOADGUARD_MEMORY_MAX", 40, 1, 100),
            ("MemorySwapMax", "LOADGUARD_MEMORY_SWAP_MAX", 10, 0, 100),
            ("CPUWeight", "LOADGUARD_CPU_WEIGHT", 50, 1, 10000))

MAX_DEPTH = 8          # ancestors searched for claude
BUSCTL_TIMEOUT_S = 2
CONFIRM_S = 1.0        # wait this long for the asynchronous move


def read(root, path):
    with open(root + path, encoding="utf-8", errors="replace") as f:
        return f.read()


def mem_total(root):
    """MemTotal in bytes, or None."""
    m = re.search(r"^MemTotal:\s+(\d+) kB$", read(root, "/proc/meminfo"), re.M)
    return int(m.group(1)) * 1024 if m else None


def env_int(environ, name, default, lo, hi):
    """Integer from the environment (a trailing % allowed), else default."""
    m = re.fullmatch(r"(\d+)%?", environ.get(name, ""))
    if m and lo <= int(m.group(1)) <= hi:
        return int(m.group(1))
    return default


def limits(root, environ):
    """{property: value} for the scope, memory in bytes; None if unknown."""
    total = mem_total(root)
    if not total:
        return None
    out = {}
    for prop, var, default, lo, hi in DEFAULTS:
        n = env_int(environ, var, default, lo, hi)
        out[prop] = n if prop == "CPUWeight" else total * n // 100
    return out


def controllers_path(uid):
    return ("/sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service/"
            "cgroup.controllers" % (uid, uid))


def delegated(root, runtime_dir, uid):
    """Is the memory controller delegated to the user manager?

    Cached per boot in <runtime_dir>/loadguard/delegation as
    "<boot_id> yes|no". An unreadable controllers file is "no", not cached:
    early in a boot the user manager may not be up yet.
    """
    boot = read(root, "/proc/sys/kernel/random/boot_id").strip()
    cache = os.path.join(runtime_dir, "loadguard", "delegation")
    try:
        cached = read("", cache).split()
        if len(cached) == 2 and cached[0] == boot and cached[1] in ("yes", "no"):
            return cached[1] == "yes"
    except OSError:
        pass
    try:
        yes = "memory" in read(root, controllers_path(uid)).split()
    except OSError:
        return False
    try:
        os.makedirs(os.path.dirname(cache), mode=0o700, exist_ok=True)
        tmp = "%s.%d" % (cache, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("%s %s\n" % (boot, "yes" if yes else "no"))
        os.replace(tmp, cache)
    except OSError:
        pass
    return yes


def lingering(root, uid):
    """Has logind a linger file for uid's user? /var/lib/systemd/linger/<name>
    is what `loginctl enable-linger` creates and logind tests for existence.
    """
    try:
        name = pwd.getpwuid(uid).pw_name
    except KeyError:
        return False
    return os.path.exists(root + "/var/lib/systemd/linger/" + name)


def ppid(root, pid):
    stat = read(root, "/proc/%d/stat" % pid)
    # comm may hold spaces and parens: the fields follow the last ')'.
    return int(stat[stat.rindex(")") + 2:].split()[1])


def is_claude(root, pid):
    try:
        if read(root, "/proc/%d/comm" % pid).strip() == "claude":
            return True
        argv0 = read(root, "/proc/%d/cmdline" % pid).split("\0")[0]
        return os.path.basename(argv0) == "claude"
    except OSError:
        return False


def find_claude(root, start):
    """(claude pid, [pids between it and start]) or (None, [])."""
    chain, pid = [], start
    for _ in range(MAX_DEPTH):
        if pid <= 1:
            break
        if is_claude(root, pid):
            return pid, chain
        chain.append(pid)
        pid = ppid(root, pid)
    return None, []


def cgroup(root, pid):
    """The cgroup v2 path of pid, or None (v1 / hybrid only)."""
    for line in read(root, "/proc/%d/cgroup" % pid).splitlines():
        if line.startswith("0::"):
            return line[3:]
    return None


def in_loadguard_scope(path):
    return any(p.startswith(PREFIX) and p.endswith(".scope")
               for p in path.split("/"))


def descendants(root, pid):
    """All live descendants of pid, found by one pass over /proc."""
    children = {}
    for name in os.listdir(root + "/proc"):
        if name.isdigit():
            try:
                children.setdefault(ppid(root, int(name)), []).append(int(name))
            except (OSError, ValueError):
                pass  # gone meanwhile, or a stat we cannot parse
    out, todo = [], [pid]
    while todo:
        for child in children.get(todo.pop(), ()):
            out.append(child)
            todo.append(child)
    return out


def scope_name(session_id, pid):
    short = re.sub(r"[^A-Za-z0-9]", "", session_id or "")[:8]
    return "%s%s%d.scope" % (PREFIX, short + "-" if short else "", pid)


def busctl_argv(busctl, name, pids, props, description):
    argv = [busctl, "--user", "--timeout=%d" % BUSCTL_TIMEOUT_S, "call",
            "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager", "StartTransientUnit",
            "ssa(sv)a(sa(sv))", name, "fail"]
    sv = [("Description", "s", description), ("Slice", "s", SLICE),
          ("PIDs", "au", [len(pids)] + list(pids))]
    sv += [(k, "t", v) for k, v in props.items()]
    # A kernel OOM kill of the outlier must not stop the scope, and with it
    # claude: OOMPolicy defaults to stop. A scope that ended failed is
    # collected anyway.
    # Delegate: AttachProcessesToUnit refuses non-delegated units.
    sv += [("OOMPolicy", "s", "continue"),
           ("CollectMode", "s", "inactive-or-failed"),
           ("Delegate", "b", "true")]
    argv.append(str(len(sv)))
    for key, sig, value in sv:
        argv += [key, sig]
        argv += [str(v) for v in value] if isinstance(value, list) \
            else [str(value)]
    argv.append("0")  # no auxiliary units
    return argv


def start_scope(busctl, name, pids, props, description):
    """True if systemd accepted the job."""
    proc = subprocess.run(
        busctl_argv(busctl, name, pids, props, description),
        stdin=subprocess.DEVNULL, capture_output=True,
        timeout=BUSCTL_TIMEOUT_S + 1)
    return proc.returncode == 0


def attach(busctl, name, pids):
    """True if systemd moved all pids into the running unit name."""
    proc = subprocess.run(
        [busctl, "--user", "--timeout=%d" % BUSCTL_TIMEOUT_S, "call",
         "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
         "org.freedesktop.systemd1.Manager", "AttachProcessesToUnit",
         "ssau", name, "", str(len(pids))] + [str(p) for p in pids],
        stdin=subprocess.DEVNULL, capture_output=True,
        timeout=BUSCTL_TIMEOUT_S + 1)
    return proc.returncode == 0


def outside(root, pids, name):
    """The pids still alive and not in the unit name."""
    out = []
    for pid in pids:
        try:
            path = cgroup(root, pid)
        except OSError:
            continue  # gone
        if path is not None and not path.endswith("/" + name):
            out.append(pid)
    return out


def wait_attached(root, pid, name):
    """Poll until pid's cgroup ends in name; the move is asynchronous."""
    deadline = time.monotonic() + CONFIRM_S
    while True:
        path = cgroup(root, pid)
        if path is not None and path.endswith("/" + name):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)


def disabled(environ):
    """LOADGUARD_CONFINE=0 turns stage 1 off; only that exact value."""
    return environ.get("LOADGUARD_CONFINE") == "0"


def user_bus(environ):
    """$XDG_RUNTIME_DIR if the user bus socket is in it, else None."""
    runtime_dir = environ.get("XDG_RUNTIME_DIR", "")
    if runtime_dir.startswith("/") and \
            os.path.exists(os.path.join(runtime_dir, "bus")):
        return runtime_dir
    return None


def find_busctl(environ):
    return shutil.which("busctl", path=environ.get("PATH", ""))


def confine(session_id, start=None, root="", environ=None, uid=None,
            me=None):
    """Attach the session's claude process to its scope. Returns a status word.

    Only the caller turns exceptions into fail-open; here a missing
    precondition is a status, not an error.
    """
    environ = os.environ if environ is None else environ
    uid = os.getuid() if uid is None else uid
    start = os.getppid() if start is None else start
    me = os.getpid() if me is None else me
    if disabled(environ):
        return "disabled"

    pid, chain = find_claude(root, start)
    if pid is None:
        return "no-claude"
    path = cgroup(root, pid)
    if path is None:
        return "no-cgroup-v2"
    if in_loadguard_scope(path):
        return "already"
    if not lingering(root, uid):
        return "no-linger"
    runtime_dir = user_bus(environ)
    if runtime_dir is None:
        return "no-bus"
    busctl = find_busctl(environ)
    if busctl is None:
        return "no-busctl"
    if not delegated(root, runtime_dir, uid):
        return "no-delegation"
    props = limits(root, environ)
    if props is None:
        return "no-meminfo"

    name = scope_name(session_id, pid)
    description = "loadguard: claude session %s" % (session_id or pid)
    if not start_scope(busctl, name, [pid], props, description):
        return "start-failed"
    if not wait_attached(root, pid, name):
        return "unconfirmed"
    # Scanned after the move: what claude forks from now on is inside
    # already. The hook and any shell between it and claude exit in a moment.
    others = outside(root, [p for p in descendants(root, pid)
                            if p not in chain and p != me], name)
    if others and not attach(busctl, name, others):
        for other in others:
            attach(busctl, name, [other])
    return "attached"
