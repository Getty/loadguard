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
// and, as the production binary has them for the CLI, on the live host:
//   --report       reads no stdin: what `loadguard-hook --report` prints
//   --explain      what `loadguard-hook --explain` prints
// Exit 1 if a Bash payload is needed and missing, 64 on usage. The C
// driver's `watch SESSION ROOT...` comes with the watcher (B5).
import { type Bytes, fixed, toBuffer } from "./bytes.js";
import { Harness, heavyCommand, MAX_WORDS, shellCommand } from "./classify.js";
import { children, get, str } from "./cjson.js";
import { hook } from "./decide.js";
import { readPressure, zramFill } from "./measure.js";
import { bashCommand, parsePayload, readAll } from "./payload.js";
import { reportExplain, reportStatus } from "./report.js";
import { scanSlots } from "./slots.js";

const args = process.argv.slice(2);
const mode = args[0] ?? "";
let out: Bytes = "";
let rc = 0;

if (args.length === 1 && mode === "--report") {
  out = reportStatus("");
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
  } else if (args.length === 1 && (mode === "command" || mode === "heavy")) {
    rc = 1;
  } else {
    rc = command !== null ? 64 : 1;
  }
}
if (out !== "") await Bun.write(Bun.stdout, toBuffer(out));
process.exit(rc);
