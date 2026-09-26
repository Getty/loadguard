"""The learned list (k15): exact commands that once took a lot of memory.

The hook binary owns every decision about it. `loadguard-hook --watch PID`,
one watcher per session scope, writes a Bash call into
${XDG_STATE_HOME:-~/.local/state}/loadguard/learned.jsonl once the call's
processes hold LOADGUARD_LEARN_RSS (20) % of MemTotal between them; the
hook reads the list and calls an exact match heavy. This module

- starts the watcher from hooks/loadguard-confine, after confine(): the
  binary in $CLAUDE_PLUGIN_DATA/bin, detached like the build
  (hooks/loadguard-build: forked, own session, stdio on /dev/null, cwd /,
  never waited for), for the process the session's scope was made for —
  the pid in the scope's name, so a nested `claude -p` or an app-server
  thread asks for the watcher that is running already. confine() moves
  the session, not the hook: after "attached" the watcher, a child of the
  hook, is moved into the scope with AttachProcessesToUnit. After
  "already" the hook runs inside the scope, and so does the watcher.
- reads and trims the list for `loadguard learned` / `forget`, under the
  flock on learned.lock the watchers take, each write a new file renamed
  over the old one.
- finds the watcher of a scope for `loadguard doctor`: the pid in
  $XDG_RUNTIME_DIR/loadguard/<scope>.watch, whose argv is `… --watch …`.

No binary (first session, build still running): no watcher this session.
LOADGUARD_LEARN=0, only that exact value: no watcher, list ignored.
"""

import fcntl
import json
import os
import re

from . import confine

FILE = "learned.jsonl"
LOCK = "learned.lock"
MAX_BYTES = 1 << 20     # the hook ignores a larger list
MAX_LINES = 256         # and reads no more lines than this
BINARY = "loadguard-hook"


def disabled(environ):
    return environ.get("LOADGUARD_LEARN") == "0"


def state_dir(environ):
    """${XDG_STATE_HOME:-$HOME/.local/state}/loadguard, as the hook binary
    finds it; None if neither is an absolute path."""
    xdg, home = environ.get("XDG_STATE_HOME", ""), environ.get("HOME", "")
    if xdg.startswith("/"):
        return os.path.join(xdg, "loadguard")
    if home.startswith("/"):
        return os.path.join(home, ".local", "state", "loadguard")
    return None


def list_path(environ):
    d = state_dir(environ)
    return os.path.join(d, FILE) if d else None


def parse(text):
    """The entries of a list text, as the hook reads them: object lines
    with a string "command", the first MAX_LINES lines."""
    out = []
    for line in text.split("\n")[:MAX_LINES]:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("command"), str):
            out.append(entry)
    return out


def read(path):
    """(entries, problem); problem None, "too-large" or an OSError text."""
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return [], None
    except OSError as e:
        return [], e.strerror or str(e)
    if len(data) > MAX_BYTES:
        return [], "too-large"
    return parse(data.decode("utf-8", "replace")), None


def rewrite(path, entries):
    """The list replaced by entries, atomically; none left: no file."""
    if not entries:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry, ensure_ascii=False,
                                   separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def forget(path, numbers=None):
    """Drop entries by number (1-based, as `loadguard learned` counts), or
    all with numbers None — then the file goes, readable or not. Returns
    the dropped entries; ValueError names a number that is not in the
    list, and nothing changes then."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with open(os.path.join(os.path.dirname(path), LOCK), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries, problem = read(path)
        if numbers is None:
            dropped, kept = entries, []
        elif problem is not None:
            raise ValueError("the list cannot be read (%s)" % problem)
        else:
            bad = [n for n in numbers if not 1 <= n <= len(entries)]
            if bad:
                raise ValueError("no entry %d: the list has %d" % (
                    bad[0], len(entries)))
            dropped = [e for i, e in enumerate(entries, 1) if i in numbers]
            kept = [e for i, e in enumerate(entries, 1) if i not in numbers]
        rewrite(path, kept)
        return dropped


# --- the watcher ---------------------------------------------------------------

def watch_file(runtime_dir, scope):
    return os.path.join(runtime_dir, "loadguard", scope + ".watch")


def watcher(environ, scope, proc_root=""):
    """The pid of the watcher holding scope's lock, or None."""
    runtime = environ.get("XDG_RUNTIME_DIR", "")
    if not runtime.startswith("/") or not scope:
        return None
    try:
        with open(watch_file(runtime, scope), encoding="ascii") as f:
            pid = int(f.read().split()[0])
        with open("%s/proc/%d/cmdline" % (proc_root, pid), "rb") as f:
            argv = f.read().split(b"\0")
    except (OSError, ValueError, IndexError):
        return None
    return pid if len(argv) > 2 and argv[1] == b"--watch" else None


def scope_in(path):
    """The loadguard-*.scope a cgroup path ends in, or None."""
    name = (path or "").rsplit("/", 1)[-1]
    return name if confine.in_loadguard_scope(name) else None


def owner(scope):
    """The pid a scope was made for: loadguard-<session>-<pid>.scope."""
    m = re.search(r"-(\d+)\.scope$", scope)
    return int(m.group(1)) if m else None


def start_watcher(status, data_dir, root="", environ=None, start=None):
    """Start the watcher of the session's scope; returns a status word.

    status is what confine() answered. Only the caller turns exceptions
    into fail-open.
    """
    environ = os.environ if environ is None else environ
    start = os.getppid() if start is None else start
    if disabled(environ):
        return "disabled"
    if status not in ("attached", "already"):
        return "not-confined"
    binary = os.path.join(data_dir, "bin", BINARY) if data_dir else ""
    if not binary or not os.access(binary, os.X_OK):
        return "no-binary"
    pid, _ = confine.find_session(root, start)
    scope = scope_in(confine.cgroup(root, pid)) if pid else None
    if scope is None:
        return "not-confined"
    argv = [binary, "--watch", str(owner(scope) or pid)]
    child = os.fork()
    if child == 0:
        try:
            os.setsid()
            devnull = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(devnull, fd)
            os.closerange(3, os.sysconf("SC_OPEN_MAX"))
            os.chdir("/")
            os.execve(binary, argv, environ)
        finally:
            os._exit(127)
    busctl = confine.find_busctl(environ)
    if status == "attached" and busctl:
        confine.attach(busctl, scope, [child])
    return "started"
