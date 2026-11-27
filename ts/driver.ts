// Test driver, the TypeScript side of the C hook's -DLOADGUARD_TEST main().
// Payload on stdin (a Bash payload unless noted), mode as the first argument:
//   command        print tool_input.command verbatim
//   heavy          print the label of the first heavy simple command, or
//                  nothing
//   measure ROOT   any payload: "full=%.2f swap=%d zram=%d" below ROOT
//   slots ROOT     any payload: busy count, then one holder per line
//   decide ROOT    any payload: exactly what the hook prints (deny, context
//                  line or nothing), with /proc and /sys below ROOT
//   report ROOT    any payload: what --report prints, below ROOT
//   explain ROOT   any payload: what --explain prints, below ROOT
//   extract        {"argv": [...], "harness": "claude"|"codex"|"any"}: the
//                  command the shell runs, as the watcher and the slot scan
//                  read it; nothing and exit 1 if there is none
//   watch SESSION ROOT...
//                  any payload: the watcher, one pass per ROOT (no sleep;
//                  the clock is LOADGUARD_TEST_NOW, default 1790000000,
//                  plus TICK_S per pass); one JSON line per thing it does,
//                  then {"watch": done|gone|locked|no-scope}
// and, as the production binary has them for the CLI, on the live host:
//   --report       reads no stdin: what `loadguard-hook --report` prints
//   --explain      what `loadguard-hook --explain` prints
// Beyond the C driver, for the parity harness of ts/scope.ts (the port of
// lib/loadguard/confine.py and learn.start_watcher):
//   scope-call     {"fn": NAME, "args": [...]} on stdin: the function's
//                  result as JSON {"value": ...}, or {"raise": KIND}
// Exit 1 if a Bash payload is needed and missing, 64 on usage.
import { type Bytes, fixed, toBuffer, utf8Bytes } from "./bytes.js";
import { Harness, heavyCommand, MAX_WORDS, shellCommand } from "./classify.js";
import { children, get, str } from "./cjson.js";
import { hook } from "./decide.js";
import { readPressure, zramFill } from "./measure.js";
import { bashCommand, parsePayload, readAll } from "./payload.js";
import { reportExplain, reportStatus } from "./report.js";
import { scopeCall } from "./scope-call.js";
import { scanSlots } from "./slots.js";
import { strtol, TICK_S, watchLock, watchSetup, watchTick, watchUnlock } from "./watcher.js";

/** driver_watch(): the log of one watcher over the roots, then its end. */
function driverWatch(arg: string, roots: Bytes[]): Bytes {
  const now = process.env["LOADGUARD_TEST_NOW"];
  const base = now !== undefined ? Number(strtol(now, 0).v) : 1790000000;
  const log: Bytes[] = [];
  const { v, end } = strtol(arg, 0);
  let status = "done";
  const setup = end !== arg.length || v <= 0n || v > 2147483647n ? null : watchSetup(roots[0] as Bytes, Number(v), log);
  if (setup === null) {
    status = "no-scope";
  } else {
    const lock = watchLock(setup.scope);
    if (lock === null) {
      status = "locked";
    } else {
      for (let i = 0; i < roots.length; i++) {
        setup.w.root = roots[i] as Bytes;
        setup.w.pass = i + 1;
        if (!watchTick(setup.w, base + TICK_S * i)) {
          status = "gone";
          break;
        }
      }
      watchUnlock(lock);
    }
  }
  return log.join("") + '{"watch":"' + status + '"}\n';
}

const args = process.argv.slice(2);
const mode = args[0] ?? "";
let out: Bytes = "";
let rc = 0;

if (args.length === 1 && mode === "--report") {
  out = reportStatus("");
} else if (args.length === 1 && mode === "scope-call") {
  out = utf8Bytes(scopeCall(await Bun.stdin.text()));
} else {
  const buf = await readAll(Bun.stdin.stream());
  const payload = buf === null ? null : parsePayload(buf);
  const command = bashCommand(payload);
  const root = args[1] ?? "";

  if (args.length === 1 && mode === "--explain") {
    out = reportExplain("", payload);
  } else if (args.length === 1 && mode === "command" && command !== null) {
    out = command;
  } else if (args.length === 1 && mode === "heavy" && command !== null) {
    out = heavyCommand(command)?.label ?? "";
  } else if (args.length === 2 && mode === "measure") {
    const pr = readPressure(root);
    out = "full=" + fixed(pr.full, 2) + " swap=" + pr.swap + " zram=" + zramFill(root);
  } else if (args.length === 2 && mode === "slots") {
    const sl = scanSlots(root);
    out = sl.busy + "\n" + sl.holders.map((h) => h + "\n").join("");
  } else if (args.length === 2 && mode === "decide") {
    out = hook(root, payload);
  } else if (args.length === 2 && mode === "report") {
    out = reportStatus(root);
  } else if (args.length === 2 && mode === "explain") {
    out = reportExplain(root, payload);
  } else if (args.length === 1 && mode === "extract") {
    const av = children(get(payload, "argv")).flatMap((a) => (a.t === "str" ? [a.v] : [])).slice(0, MAX_WORDS);
    const h = str(get(payload, "harness"));
    const cmd = shellCommand(av, h === "claude" ? Harness.CLAUDE : h === "codex" ? Harness.CODEX : Harness.ANY);
    if (cmd === null) rc = 1;
    else out = cmd;
  } else if (args.length >= 3 && mode === "watch") {
    out = driverWatch(args[1] as string, args.slice(2).map(utf8Bytes));
  } else if (args.length === 1 && (mode === "command" || mode === "heavy")) {
    rc = 1;
  } else {
    rc = command !== null ? 64 : 1;
  }
}
if (out !== "") await Bun.write(Bun.stdout, toBuffer(out));
process.exit(rc);
