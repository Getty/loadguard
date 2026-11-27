// @bun
// ts/scope.ts
import { spawn } from "child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { setPriority } from "os";

// ts/libc.ts
import { CString, dlopen, FFIType, read } from "bun:ffi";
var libc;
function loadLibc() {
  if (libc !== undefined)
    return libc;
  try {
    const lib = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      getpwuid: { args: [FFIType.u32], returns: FFIType.ptr },
      strerror: { args: [FFIType.i32], returns: FFIType.cstring }
    });
    libc = {
      flock: (fd, op) => lib.symbols.flock(fd, op),
      userName: (uid) => {
        const pw = lib.symbols.getpwuid(uid);
        if (pw === null)
          return null;
        const name = read.ptr(pw, 0);
        return name === 0 ? null : new CString(name).toString();
      },
      strerror: (errno) => String(lib.symbols.strerror(errno))
    };
  } catch {
    libc = null;
  }
  return libc;
}

// ts/scope.ts
var SLICE = "app-loadguard.slice";
var PREFIX = "loadguard-";
var DEFAULTS = [
  ["MemoryHigh", "LOADGUARD_MEMORY_HIGH", 30, 1, 100],
  ["MemoryMax", "LOADGUARD_MEMORY_MAX", 40, 1, 100],
  ["MemorySwapMax", "LOADGUARD_MEMORY_SWAP_MAX", 10, 0, 100],
  ["CPUWeight", "LOADGUARD_CPU_WEIGHT", 50, 1, 1e4]
];
var SESSION_NAMES = ["claude", "codex"];
var MAX_DEPTH = 8;
var BUSCTL_TIMEOUT_S = 2;
var CONFIRM_S = 1;
var BUN_ENV_REMOVED = [
  "BUN_OPTIONS",
  "BUN_INSPECT_PRELOAD",
  "BUN_INSPECT",
  "BUN_INSPECT_CONNECT_TO",
  "NODE_PATH",
  "NODE_COMPILE_CACHE",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "BUN_INTERNAL_WEBVIEW_HOST"
];

class PyError extends Error {
  kind;
  constructor(kind, message) {
    super(kind + ": " + message);
    this.kind = kind;
  }
}
var PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
var SPLIT = new RegExp(`[${PY_WS}]+`);
var LINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
var MEMTOTAL = new RegExp(`(?:^|(?<=\\n))MemTotal:[${PY_WS}]+([0-9]+) kB(?=\\n|$)`);
function pyStrip(s) {
  return s.replace(STRIP, "");
}
function pySplit(s) {
  return s.split(SPLIT).filter((w) => w !== "");
}
function pySplitlines(s) {
  const lines = s.split(LINES);
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines;
}
function pyInt(s) {
  const t = pyStrip(s);
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(t))
    throw new PyError("ValueError", "invalid literal for int(): " + s);
  return Number(BigInt(t.replace(/_/g, "")));
}
function pyJoin(a, ...parts) {
  let out = a;
  for (const p of parts)
    out = p.startsWith("/") ? p : out === "" || out.endsWith("/") ? out + p : out + "/" + p;
  return out;
}
function wellFormed(s) {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}
function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}
function dirname(p) {
  const i = p.lastIndexOf("/") + 1;
  const head = p.slice(0, i);
  return head !== "" && head !== "/".repeat(head.length) ? head.replace(/\/+$/, "") : head;
}
function makedirs(path, mode) {
  const head = dirname(path);
  if (head !== "" && basename(path) !== "" && !existsSync(head))
    makedirs(head, 511);
  try {
    mkdirSync(path, { mode });
  } catch (e) {
    let dir = false;
    try {
      dir = statSync(path).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir)
      throw new PyError("OSError", String(e));
  }
}
var DECODER = new TextDecoder("utf-8");
function read2(root, path) {
  let buf;
  try {
    buf = readFileSync(root + path);
  } catch (e) {
    throw new PyError("OSError", String(e));
  }
  return DECODER.decode(buf).replace(/\r\n?/g, `
`);
}
function memTotal(root) {
  const m = MEMTOTAL.exec(read2(root, "/proc/meminfo"));
  return m === null ? null : BigInt(m[1]) * 1024n;
}
function envInt(environ, name, def, lo, hi) {
  const m = /^([0-9]+)%?$/.exec(environ[name] ?? "");
  if (m !== null) {
    const n = BigInt(m[1]);
    if (BigInt(lo) <= n && n <= BigInt(hi))
      return Number(n);
  }
  return def;
}
function limits(root, environ) {
  const total = memTotal(root);
  if (!total)
    return null;
  return DEFAULTS.map(([prop, name, def, lo, hi]) => {
    const n = BigInt(envInt(environ, name, def, lo, hi));
    return [prop, prop === "CPUWeight" ? n : total * n / 100n];
  });
}
function controllersPath(uid) {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
}
function delegated(root, runtimeDir, uid) {
  const boot = pyStrip(read2(root, "/proc/sys/kernel/random/boot_id"));
  const cache = pyJoin(runtimeDir, "loadguard", "delegation");
  try {
    const cached = pySplit(read2("", cache));
    if (cached.length === 2 && cached[0] === boot && (cached[1] === "yes" || cached[1] === "no"))
      return cached[1] === "yes";
  } catch (e) {
    if (!(e instanceof PyError))
      throw e;
  }
  let yes;
  try {
    yes = pySplit(read2(root, controllersPath(uid))).includes("memory");
  } catch (e) {
    if (!(e instanceof PyError))
      throw e;
    return false;
  }
  try {
    makedirs(dirname(cache), 448);
    const tmp = `${cache}.${process.pid}`;
    writeFileSync(tmp, `${boot} ${yes ? "yes" : "no"}
`);
    renameSync(tmp, cache);
  } catch {}
  return yes;
}
function userName(uid) {
  const libc = loadLibc();
  if (libc !== null)
    return libc.userName(uid);
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split(`
`)) {
      const f = line.split(":");
      if (f.length >= 3 && f[2] === String(uid))
        return f[0];
    }
  } catch {}
  return null;
}
function lingering(root, user) {
  return user !== null && existsSync(root + "/var/lib/systemd/linger/" + user);
}
function ppid(root, pid) {
  const stat = read2(root, `/proc/${pid}/stat`);
  const close = stat.lastIndexOf(")");
  if (close < 0)
    throw new PyError("ValueError", "substring not found");
  const fields = pySplit(stat.slice(close + 2));
  if (fields.length < 2)
    throw new PyError("IndexError", "list index out of range");
  return pyInt(fields[1]);
}
function sessionName(root, pid) {
  try {
    const comm = pyStrip(read2(root, `/proc/${pid}/comm`));
    if (SESSION_NAMES.includes(comm))
      return comm;
    const name = basename(read2(root, `/proc/${pid}/cmdline`).split("\x00")[0]);
    return SESSION_NAMES.includes(name) ? name : null;
  } catch (e) {
    if (e instanceof PyError && e.kind === "OSError")
      return null;
    throw e;
  }
}
function findSession(root, start) {
  const chain = [];
  let pid = start;
  for (let i = 0;i < MAX_DEPTH; i++) {
    if (pid <= 1)
      break;
    if (sessionName(root, pid) !== null)
      return [pid, chain];
    chain.push(pid);
    pid = ppid(root, pid);
  }
  return [null, []];
}
function cgroup(root, pid) {
  for (const line of pySplitlines(read2(root, `/proc/${pid}/cgroup`)))
    if (line.startsWith("0::"))
      return line.slice(3);
  return null;
}
function inLoadguardScope(path) {
  return path.split("/").some((p) => p.startsWith(PREFIX) && p.endsWith(".scope"));
}
function descendants(root, pid) {
  let names;
  try {
    names = readdirSync(root + "/proc");
  } catch (e) {
    throw new PyError("OSError", String(e));
  }
  const children = new Map;
  for (const name of names) {
    if (!/^[0-9]+$/.test(name))
      continue;
    try {
      const child = pyInt(name), parent = ppid(root, child);
      const list = children.get(parent);
      if (list === undefined)
        children.set(parent, [child]);
      else
        list.push(child);
    } catch (e) {
      if (!(e instanceof PyError) || e.kind === "IndexError")
        throw e;
    }
  }
  const out = [], todo = [pid];
  while (todo.length > 0) {
    for (const child of children.get(todo.pop()) ?? []) {
      out.push(child);
      todo.push(child);
    }
  }
  return out;
}
function scopeName(sessionId, pid) {
  const short = (sessionId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `${PREFIX}${short !== "" ? short + "-" : ""}${pid}.scope`;
}
function busctlArgv(busctl, name, pids, props, description) {
  const argv = [
    busctl,
    "--user",
    `--timeout=${BUSCTL_TIMEOUT_S}`,
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    name,
    "fail"
  ];
  const sv = [
    ["Description", "s", [description]],
    ["Slice", "s", [SLICE]],
    ["PIDs", "au", [String(pids.length), ...pids.map(String)]],
    ...props.map(([k, v]) => [k, "t", [String(v)]]),
    ["OOMPolicy", "s", ["continue"]],
    ["CollectMode", "s", ["inactive-or-failed"]],
    ["Delegate", "b", ["true"]]
  ];
  argv.push(String(sv.length));
  for (const [key, sig, value] of sv)
    argv.push(key, sig, ...value);
  argv.push("0");
  return argv;
}
function run(argv) {
  for (const a of argv)
    if (a.includes("\x00") || !wellFormed(a))
      throw new PyError("ValueError", "argument not passable");
  const r = Bun.spawnSync({
    cmd: argv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: (BUSCTL_TIMEOUT_S + 1) * 1000,
    killSignal: "SIGKILL"
  });
  if (r.exitedDueToTimeout)
    throw new PyError("OSError", "busctl timed out");
  return r.exitCode;
}
function startScope(busctl, name, pids, props, description) {
  return run(busctlArgv(busctl, name, pids, props, description)) === 0;
}
function attach(busctl, name, pids) {
  return run([
    busctl,
    "--user",
    `--timeout=${BUSCTL_TIMEOUT_S}`,
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "AttachProcessesToUnit",
    "ssau",
    name,
    "",
    String(pids.length),
    ...pids.map(String)
  ]) === 0;
}
function outside(root, pids, name) {
  const out = [];
  for (const pid of pids) {
    let path;
    try {
      path = cgroup(root, pid);
    } catch (e) {
      if (e instanceof PyError && e.kind === "OSError")
        continue;
      throw e;
    }
    if (path !== null && !path.endsWith("/" + name))
      out.push(pid);
  }
  return out;
}
function waitAttached(root, pid, name, confirmS = CONFIRM_S) {
  const deadline = performance.now() + confirmS * 1000;
  for (;; ) {
    const path = cgroup(root, pid);
    if (path !== null && path.endsWith("/" + name))
      return true;
    if (performance.now() >= deadline)
      return false;
    Bun.sleepSync(10);
  }
}
function userBus(environ) {
  const runtimeDir = environ["XDG_RUNTIME_DIR"] ?? "";
  return runtimeDir.startsWith("/") && existsSync(pyJoin(runtimeDir, "bus")) ? runtimeDir : null;
}
function findBusctl(environ) {
  const path = environ["PATH"] ?? "";
  if (path === "")
    return null;
  const seen = new Set;
  for (const dir of path.split(":")) {
    if (seen.has(dir))
      continue;
    seen.add(dir);
    const name = pyJoin(dir, "busctl");
    try {
      accessSync(name, constants.X_OK);
      if (!statSync(name).isDirectory())
        return name;
    } catch {}
  }
  return null;
}
function confine(sessionId, host = {}) {
  const root = host.root ?? "", environ = host.environ ?? process.env;
  const uid = host.uid ?? process.getuid?.() ?? -1;
  const start = host.start ?? process.ppid, me = host.me ?? process.pid;
  if (environ["LOADGUARD_CONFINE"] === "0")
    return "disabled";
  const [pid, chain] = findSession(root, start);
  if (pid === null)
    return "no-session";
  const path = cgroup(root, pid);
  if (path === null)
    return "no-cgroup-v2";
  if (inLoadguardScope(path))
    return "already";
  if (!lingering(root, host.user !== undefined ? host.user : userName(uid)))
    return "no-linger";
  const runtimeDir = userBus(environ);
  if (runtimeDir === null)
    return "no-bus";
  const busctl = findBusctl(environ);
  if (busctl === null)
    return "no-busctl";
  if (!delegated(root, runtimeDir, uid))
    return "no-delegation";
  const props = limits(root, environ);
  if (props === null)
    return "no-meminfo";
  const name = scopeName(sessionId, pid);
  const description = `loadguard: ${sessionName(root, pid) ?? "None"} session ${sessionId || pid}`;
  if (!startScope(busctl, name, [pid], props, description))
    return "start-failed";
  if (!waitAttached(root, pid, name, host.confirmS ?? CONFIRM_S))
    return "unconfirmed";
  const others = outside(root, descendants(root, pid).filter((p) => !chain.includes(p) && p !== me), name);
  if (others.length > 0 && !attach(busctl, name, others))
    for (const other of others)
      attach(busctl, name, [other]);
  return "attached";
}
function scopeIn(path) {
  const name = (path ?? "").split("/").pop();
  return inLoadguardScope(name) ? name : null;
}
function owner(scope) {
  const m = /-([0-9]+)\.scope\n?$/.exec(scope);
  return m === null ? null : Number(m[1]);
}
function startWatcher(status, launch = {}) {
  const root = launch.root ?? "", environ = launch.environ ?? process.env;
  const start = launch.start ?? process.ppid;
  const entry = launch.entry ?? import.meta.dir + "/watch.js";
  if (environ["LOADGUARD_LEARN"] === "0")
    return "disabled";
  if (status !== "attached" && status !== "already")
    return "not-confined";
  try {
    accessSync(entry, constants.R_OK);
    if (!statSync(entry).isFile())
      return "no-entry";
  } catch {
    return "no-entry";
  }
  const [pid] = findSession(root, start);
  const scope = pid !== null && pid !== 0 ? scopeIn(cgroup(root, pid)) : null;
  if (scope === null || pid === null)
    return "not-confined";
  const env = { ...environ };
  for (const name of BUN_ENV_REMOVED)
    delete env[name];
  const child = spawn(launch.execPath ?? process.execPath, ["--no-install", "--config=/dev/null", "--no-env-file", entry, String(owner(scope) || pid)], { detached: true, stdio: "ignore", cwd: "/", env });
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined)
    return "spawn-failed";
  try {
    setPriority(child.pid, 10);
  } catch {}
  const busctl = findBusctl(environ);
  if (status === "attached" && busctl !== null)
    attach(busctl, scope, [child.pid]);
  return "started";
}

// ts/confine.ts
async function main() {
  const raw = new Uint8Array(await Bun.stdin.arrayBuffer());
  let sessionId = null;
  try {
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const id = payload["session_id"];
      sessionId = typeof id === "string" ? id : null;
    }
  } catch {
    sessionId = null;
  }
  const status = confine(sessionId);
  if (process.argv[2] === "--status")
    await Bun.write(Bun.stdout, status + `
`);
  startWatcher(status);
}
try {
  await main();
} catch {}
process.exit(0);
