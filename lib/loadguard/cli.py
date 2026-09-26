"""bin/loadguard: status, doctor, explain (k5).

The decisions exist once, in the C hook (src/loadguard-hook.c). This module
finds that binary, runs one of its read-only report modes and formats the
JSON it prints:

  loadguard-hook --report    limits, pressure, heavy slots and who holds
                             them, as the hook's heavy path sees the host
  loadguard-hook --explain   a hook payload on stdin: the hook's answer and
                             what it measured on the way

Nothing here classifies a command, scans /proc for slots or holds a figure
against a limit. Stage 1 is Python already: doctor asks confine.py and
build.py the questions they answer for the SessionStart hooks.

Which binary: $CLAUDE_PLUGIN_DATA/bin if set (hooks get it; the Bash tool
does not). Else, for a copy installed from a marketplace, which lives in
<plugins>/cache/<marketplace>/<plugin>/<version>/, its data directory
<plugins>/data/<id>: the id <plugin>@<marketplace> with every character
but letters, digits, _ and - turned into - (plugins-reference, "Environment
variables"). Else, in a checkout, build/bin (make), or the data directory of
a --plugin-dir session (<name>@inline).
"""

import json
import os
import pwd
import re
import subprocess
import sys

from . import build, confine

NAME = "loadguard"
REPORT_FORMAT = 1
# Under pressure the binary does not scan /proc, so a report takes
# milliseconds; this only bounds the unexpected.
TIMEOUT_S = 10
LABEL = 9           # "session: "


class NoReport(Exception):
    """The binary gave no report; the message says why."""


# --- the binary -------------------------------------------------------------

def binary_in(data_dir):
    return os.path.join(data_dir, "bin", build.BINARY)


def data_id(ident):
    return re.sub(r"[^A-Za-z0-9_-]", "-", ident)


def find_data_dir(root, environ):
    """(data directory the hook binary is built into, how it was found)."""
    if environ.get("CLAUDE_PLUGIN_DATA"):
        return environ["CLAUDE_PLUGIN_DATA"], "$CLAUDE_PLUGIN_DATA"
    plugin = os.path.dirname(root)
    market = os.path.dirname(plugin)
    cache = os.path.dirname(market)
    if os.path.basename(cache) == "cache":
        ident = "%s@%s" % (os.path.basename(plugin), os.path.basename(market))
        return (os.path.join(os.path.dirname(cache), "data", data_id(ident)),
                "installed as " + ident)
    local = os.path.join(root, "build")
    plugins = environ.get("CLAUDE_CODE_PLUGIN_CACHE_DIR") or (
        os.path.join(environ["HOME"], ".claude", "plugins")
        if environ.get("HOME") else None)
    if not os.path.exists(binary_in(local)) and plugins:
        inline = os.path.join(plugins, "data", data_id(NAME + "@inline"))
        if os.path.exists(binary_in(inline)):
            return inline, "--plugin-dir session, %s@inline" % NAME
    return local, "checkout, built by make"


def run_report(argv, stdin=None, environ=None, timeout=TIMEOUT_S):
    """The report the binary prints, as a dict; NoReport if there is none."""
    try:
        proc = subprocess.Popen(
            argv, env=environ, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL if stdin is None else subprocess.PIPE)
    except OSError as e:
        raise NoReport("cannot run %s: %s" % (argv[0], e.strerror))
    try:
        out, _ = proc.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        # Not waited for: a reader stuck on swap may not die at once.
        proc.kill()
        raise NoReport("%s gave no answer within %d s" % (argv[0], timeout))
    try:
        doc = json.loads(out.decode("utf-8"))
    except ValueError:
        doc = None
    if not isinstance(doc, dict) or doc.get("report") != REPORT_FORMAT:
        raise NoReport("%s has no report mode: it was built from other "
                       "sources" % argv[0])
    return doc


def payload(command):
    """The hook payload Claude Code would send for this Bash command."""
    return json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                       "tool_input": {"command": command}}).encode("ascii")


# --- the session -------------------------------------------------------------

def session(proc_root="", start=None):
    """(claude pid, its cgroup path) of the session this runs in.

    pid None outside a Claude Code session; path None without cgroup v2.
    """
    start = os.getppid() if start is None else start
    try:
        pid, _ = confine.find_claude(proc_root, start)
        return pid, (confine.cgroup(proc_root, pid) if pid else None)
    except (OSError, ValueError, IndexError):
        return None, None


def scope_of(path):
    """The loadguard-*.scope in a cgroup path, or None."""
    for part in (path or "").split("/"):
        if confine.in_loadguard_scope(part):
            return part
    return None


def session_text(pid, path):
    if pid is None:
        return "not run from a Claude Code session"
    scope = scope_of(path)
    if scope:
        return "confined in " + scope
    return "not confined (cgroup %s)" % (path or "n/a")


# --- formatting --------------------------------------------------------------

def rows(label, lines):
    """'label:  first line', the others indented below it."""
    return [("%-*s" % (LABEL, label + ":") if i == 0 else " " * LABEL) + line
            for i, line in enumerate(lines)]


def percent(value, digits=0):
    return "n/a" if value is None else "%.*f%%" % (digits, value)


def memory(doc):
    p, lim = doc["pressure"], doc["limits"]
    text = "PSI full %s (limit %d%%), some %s; swap %s used (limit %d%%)" % (
        percent(p["full"], 2), lim["psi_full"], percent(p["some"], 2),
        percent(p["swap"]), lim["swap_used"])
    if p["zram"] is not None:
        text += "; zram %d%% full" % p["zram"]
    return text


def slot_lines(doc):
    slots = doc["slots"]
    if slots is None:
        return ["not scanned: under memory pressure the hook reads no other",
                "process (that can stall on swap); pressure alone refuses"]
    lines = ["%d/%d heavy busy" % (slots["busy"], doc["limits"]["slots"])]
    lines += slots["holders"]
    if slots["busy"] > len(slots["holders"]):
        lines.append("+%d more" % (slots["busy"] - len(slots["holders"])))
    return lines


def ignored_lines(names, environ):
    lines = []
    for name in names:
        value = environ.get(name, "")
        if name in ("LOADGUARD_THROTTLE", "LOADGUARD_CONFINE"):
            lines.append("%s=%r changes nothing: only 0 turns it off"
                         % (name, value))
        else:
            lines.append("%s=%r is not valid: the default applies"
                         % (name, value))
    return lines


def heavy_now(doc):
    if not doc["throttle"]:
        return "never refused: LOADGUARD_THROTTLE=0"
    if not doc["refuse_heavy"]:
        return "a heavy command would run now"
    return "a heavy command would be refused now (%s)" % (
        "memory pressure" if doc["pressured"] else "all heavy slots busy")


def format_status(doc, environ, session_line, hook_line):
    return (rows("memory", [memory(doc)]) + rows("slots", slot_lines(doc)) +
            rows("heavy", [heavy_now(doc)]) +
            rows("ignored", ignored_lines(doc["ignored"], environ)) +
            rows("session", [session_line]) + rows("hook", [hook_line]))


def format_explain(doc, environ):
    lines = rows("ignored", ignored_lines(doc["ignored"], environ))
    if not doc["bash"]:
        return lines + rows("verdict", [
            "allow: not a Bash payload the hook can read; it passes it "
            "through"])
    if not doc["throttle"]:
        lines += rows("heavy", ["not checked: LOADGUARD_THROTTLE=0"])
    elif doc["heavy"] is None:
        lines += rows("heavy", ["no: a light command is never refused; the "
                                "hook reads nothing for it"])
    else:
        lines += rows("heavy", ["yes (%s)" % doc["heavy"]])
        lines += rows("memory", [memory(doc)]) + rows("slots", slot_lines(doc))
    if doc["decision"] == "deny":
        return lines + rows("verdict", ["deny; the model is told:"] +
                            doc["reason"].split("\n"))
    return lines + rows("verdict", ["allow: the hook stays silent, the "
                                    "command runs"])


# --- status, explain ---------------------------------------------------------

def status(root, environ):
    data_dir, how = find_data_dir(root, environ)
    binary = binary_in(data_dir)
    here = session_text(*session())
    if not os.access(binary, os.X_OK):
        print("\n".join(rows("hook", [
            "pass-through, nothing is refused now: no binary at %s (%s)"
            % (binary, how),
            "it is built at the next session start; `loadguard doctor` "
            "says more"]) + rows("session", [here])))
        return 0
    try:
        doc = run_report([binary, "--report"], environ=environ)
    except NoReport as e:
        print("\n".join(rows("hook", [str(e), "see `loadguard doctor`"]) +
                        rows("session", [here])))
        return 1
    print("\n".join(format_status(doc, environ, here,
                                  "%s (%s)" % (binary, how))))
    return 0


def explain(root, environ, command):
    binary = binary_in(find_data_dir(root, environ)[0])
    if not os.access(binary, os.X_OK):
        print("\n".join(rows("verdict", [
            "allow: pass-through, nothing is refused now: no hook binary at "
            + binary,
            "it is built at the next session start; `loadguard doctor` "
            "says more"])))
        return 0
    try:
        doc = run_report([binary, "--explain"], payload(command), environ)
    except NoReport as e:
        print("\n".join(rows("hook", [str(e), "see `loadguard doctor`"])))
        return 1
    print("\n".join(format_explain(doc, environ)))
    return 0


# --- doctor ------------------------------------------------------------------

def size(n):
    return "%.1f GiB" % (n / 2 ** 30) if n >= 2 ** 30 else \
        "%d MiB" % (n // 2 ** 20)


def confine_ignored(environ):
    """Stage 1 variables that are set and change nothing (confine.py)."""
    names = []
    if "LOADGUARD_CONFINE" in environ and not confine.disabled(environ):
        names.append("LOADGUARD_CONFINE")
    for _prop, var, _default, lo, hi in confine.DEFAULTS:
        if var in environ and confine.env_int(environ, var, None, lo, hi) \
                is None:
            names.append(var)
    return names


def stage1(environ, proc_root, uid, me, start):
    """(header, [(status, text, hint)]): stage 1 as confine() sees it."""
    off = confine.disabled(environ)
    bad = "--" if off else "FAIL"
    out = []
    try:
        v2 = confine.cgroup(proc_root, me) is not None
    except OSError:
        v2 = False
    out.append(("ok", "cgroup v2", None) if v2 else (
        bad, "no cgroup v2", "confinement needs the unified hierarchy"))
    runtime_dir = confine.user_bus(environ)
    busctl = confine.find_busctl(environ)
    out.append(("ok", "user bus in %s, %s" % (runtime_dir, busctl), None)
               if runtime_dir and busctl else (
        bad, "no user bus ($XDG_RUNTIME_DIR/bus)" if not runtime_dir
        else "no busctl on PATH", "confinement talks to systemd --user"))
    delegated = False
    if runtime_dir:
        try:
            delegated = confine.delegated(proc_root, runtime_dir, uid)
        except OSError:
            pass
        out.append(("ok", "memory controller delegated to user@%d.service"
                    % uid, None) if delegated else (
            bad, "memory controller not delegated to user@%d.service" % uid,
            "see " + confine.controllers_path(uid)))
    else:
        out.append(("--", "delegation not checked without a user bus", None))
    try:
        user = pwd.getpwuid(uid).pw_name
    except KeyError:
        user = str(uid)
    linger = confine.lingering(proc_root, uid)
    out.append(("ok", "linger for " + user, None) if linger else (
        bad, "no linger for " + user,
        "loginctl enable-linger; without it sessions stay unconfined"))
    try:
        limits = confine.limits(proc_root, environ)
    except OSError:
        limits = None
    if limits:
        out.append(("ok", "limits " + ", ".join(
            "%s %s" % (k, v if k == "CPUWeight" else size(v))
            for k, v in limits.items()), None))
    else:
        out.append((bad, "no MemTotal in /proc/meminfo", None))
    works = v2 and runtime_dir and busctl and delegated and linger and limits

    pid, path = session(proc_root, start)
    if pid is None or scope_of(path):
        out.append(("ok" if pid else "--",
                    "this session: " + session_text(pid, path), None))
    else:
        out.append(("FAIL" if works and not off else "--",
                    "this session: " + session_text(pid, path),
                    "sessions are confined when they start; start a new one"
                    if works and not off else None))
    return ("stage 1, confine sessions: " +
            ("off (LOADGUARD_CONFINE=0)" if off else
             "on" if works else "cannot work here"), out)


def stage23(root, environ):
    """(header, rows, report or None) for the hook binary."""
    data_dir, how = find_data_dir(root, environ)
    binary = binary_in(data_dir)
    if os.path.exists(os.path.join(root, "Makefile")) and \
            data_dir == os.path.join(root, "build"):
        rebuild = "make in " + root
    else:
        rebuild = "python3 %s --foreground %s" % (
            os.path.join(root, "hooks", "loadguard-build"), data_dir)
    out = []
    present = os.access(binary, os.X_OK)
    out.append(("ok", "hook binary %s (%s)" % (binary, how), None)
               if present else (
        "FAIL", "no hook binary at %s (%s): every Bash command passes "
        "through" % (binary, how),
        "built at the next session start; now: " + rebuild))
    cc = build.find_cc(environ)
    if cc is None:
        out.append(("--", "no C compiler ($CC, cc, gcc): the binary cannot "
                    "be checked against these sources or rebuilt", None)
                   if present else (
            "FAIL", "no C compiler ($CC, cc, gcc): the hook cannot be built",
            None))
    elif present:
        try:
            fresh = build.current(root, data_dir, cc)
        except OSError:
            fresh = None
        if fresh is None:
            out.append(("--", "sources of %s not readable" % root, None))
        else:
            out.append(("ok", "built from these sources with " + cc, None)
                       if fresh else (
                "FAIL", "stale: built from other sources, flags or compiler",
                "rebuilt at the next session start; now: " + rebuild))
    doc = None
    if present:
        try:
            doc = run_report([binary, "--report"], environ=environ)
        except NoReport as e:
            out.append(("FAIL", str(e), "rebuild: " + rebuild))
    if doc is None:
        header = "pass-through" if not present else "unknown"
    elif not doc["throttle"]:
        header = "off (LOADGUARD_THROTTLE=0)"
    else:
        header = "on"
        lim = doc["limits"]
        out.append(("ok", "limits memory PSI full %d%%, swap %d%% used, %d "
                    "heavy slots" % (lim["psi_full"], lim["swap_used"],
                                     lim["slots"]), None))
    return "stage 2/3, refuse heavy commands: " + header, out, doc


def doctor_sections(root, environ, proc_root="", uid=None, me=None,
                    start=None):
    """[(title, [(status, text, hint)])]; a FAIL means exit 1."""
    uid = os.getuid() if uid is None else uid
    me = os.getpid() if me is None else me
    sections = [stage1(environ, proc_root, uid, me, start)]
    header, out, doc = stage23(root, environ)
    sections.append((header, out))
    names = (doc["ignored"] if doc else []) + confine_ignored(environ)
    if names:
        sections.append(("environment", [
            ("FAIL", line, None) for line in ignored_lines(names, environ)]))
    return sections


def doctor(root, environ, **where):
    sections = doctor_sections(root, environ, **where)
    print("loadguard doctor")
    fails = 0
    for title, checks in sections:
        print(title)
        for state, text, hint in checks:
            fails += state == "FAIL"
            print("  %-4s  %s" % (state, text))
            if hint:
                print("        -> " + hint)
    print("all good" if not fails else
          "%d problem%s" % (fails, "" if fails == 1 else "s"))
    return 1 if fails else 0


USAGE = """usage: loadguard status | doctor | explain '<command>'
  status    memory pressure, heavy slots and who holds them, as the hook
            sees them
  doctor    can loadguard work here? exit 1 if something is broken
  explain   what the hook would do with this Bash command now (dry run)"""


def main(argv, root, environ=None):
    environ = os.environ if environ is None else environ
    if argv[:1] in (["-h"], ["--help"], ["help"]):
        print(USAGE)
        return 0
    if argv == ["status"]:
        return status(root, environ)
    if argv == ["doctor"]:
        return doctor(root, environ)
    if argv[:1] == ["explain"] and len(argv) > 1:
        return explain(root, environ, " ".join(argv[1:]))
    sys.stderr.write(USAGE + "\n")
    return 2
