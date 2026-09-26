"""Build the C hook (src/loadguard-hook.c) on the target host.

Called from the SessionStart hook (hooks/loadguard-build), never on the Bash
path: until a binary exists the PreToolUse starter passes every command
through. The binary lives in ${CLAUDE_PLUGIN_DATA}/bin, which survives plugin
updates; ${CLAUDE_PLUGIN_ROOT} moves with every version.

"Stale" is decided by content, not mtimes: a stamp file next to the binary
holds a hash over the sources, the flags and the compiler's identity (resolved
path, size, mtime). A plugin update with changed sources, a compiler upgrade
or new flags rebuild; copied files with odd mtimes do not fool it.
"""

import fcntl
import hashlib
import os
import shutil
import subprocess
import tempfile

HOOK_SOURCE = os.path.join("src", "loadguard-hook.c")
CJSON_DIR = os.path.join("vendor", "cJSON")
SOURCES = (HOOK_SOURCE, os.path.join(CJSON_DIR, "cJSON.c"),
           os.path.join(CJSON_DIR, "cJSON.h"))

FLAGS = ("-O2", "-Wall", "-Wextra")
# Tests: warnings are errors, memory errors and UB abort with a non-zero exit.
TEST_FLAGS = FLAGS + ("-Werror", "-g", "-fsanitize=address,undefined",
                      "-fno-sanitize-recover=all")

BINARY = "loadguard-hook"
TIMEOUT_S = 120


def find_cc(environ=None):
    """The C compiler — $CC, else cc or gcc on PATH — or None."""
    environ = os.environ if environ is None else environ
    path = environ.get("PATH", "")
    names = [environ["CC"]] if environ.get("CC") else ["cc", "gcc"]
    for name in names:
        found = shutil.which(name, path=path)
        if found:
            return found
    return None


def stamp(root, cc, flags=FLAGS):
    """Hash over everything the binary depends on."""
    h = hashlib.sha256()
    for rel in SOURCES:
        with open(os.path.join(root, rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    st = os.stat(cc)
    h.update(repr((os.path.realpath(cc), st.st_size, st.st_mtime_ns,
                   tuple(flags))).encode())
    return h.hexdigest()


def compile_hook(root, cc, out, flags=FLAGS, defines=(), timeout=TIMEOUT_S):
    """Compile into `out` atomically (temp file beside it, then rename).

    Returns (ok, compiler output). On failure `out` is left as it was.
    """
    outdir = os.path.dirname(os.path.abspath(out))
    os.makedirs(outdir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(out) + ".",
                               suffix=".tmp", dir=outdir)
    os.close(fd)
    cmd = [cc, *flags, *defines, "-I", os.path.join(root, CJSON_DIR),
           "-o", tmp, os.path.join(root, HOOK_SOURCE),
           os.path.join(root, CJSON_DIR, "cJSON.c"), "-lm"]
    try:
        proc = subprocess.run(cmd, stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=timeout)
        output = (proc.stdout + proc.stderr).decode("utf-8", "replace")
        if proc.returncode != 0:
            return False, output or "exit %d" % proc.returncode
        os.chmod(tmp, 0o755)
        os.replace(tmp, out)
        return True, output
    except (OSError, subprocess.SubprocessError) as e:
        return False, "%s: %s" % (type(e).__name__, e)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _current(out, stamp_file, key):
    try:
        with open(stamp_file, encoding="ascii") as f:
            return f.read().strip() == key and os.access(out, os.X_OK)
    except OSError:
        return False


def _write(path, text):
    outdir = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".tmp.", dir=outdir)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def ensure(root, data_dir, environ=None):
    """Build data_dir/bin/loadguard-hook unless it is current.

    Returns one of: "no-compiler" (nothing touched), "current", "busy"
    (another build holds the lock), "built", "failed" (binary and stamp
    removed: without a binary for these sources the hook passes through).
    """
    cc = find_cc(environ)
    if cc is None:
        return "no-compiler"
    bindir = os.path.join(data_dir, "bin")
    out = os.path.join(bindir, BINARY)
    stamp_file = out + ".stamp"
    key = stamp(root, cc)
    if _current(out, stamp_file, key):
        return "current"
    os.makedirs(bindir, exist_ok=True)
    with open(os.path.join(bindir, ".build.lock"), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return "busy"
        if _current(out, stamp_file, key):
            return "current"
        ok, output = compile_hook(root, cc, out)
        if ok:
            _write(stamp_file, key + "\n")
        else:
            for path in (stamp_file, out):
                if os.path.exists(path):
                    os.unlink(path)
        status = "built" if ok else "failed"
        _write(os.path.join(data_dir, "build.log"),
               "%s with %s\n%s" % (status, cc, output))
        return status
