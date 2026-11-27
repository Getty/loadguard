// Test driver, the TypeScript side of the C hook's -DLOADGUARD_TEST main().
// Payload on stdin, mode as the first argument:
//   command   print tool_input.command verbatim
// Exit 1 if a Bash payload is needed and missing, 64 on usage. Further modes
// follow as the decision logic is ported (k18 onward).
import { bashToolInput, parsePayload, readAll } from "./payload.js";

const buf = await readAll(Bun.stdin.stream());
const input = bashToolInput(buf === null ? null : parsePayload(buf));
const args = process.argv.slice(2);
let rc = 0;

if (args.length === 1 && args[0] === "command") {
  if (input === null) rc = 1;
  else if (input.command !== "") await Bun.write(Bun.stdout, input.command);
} else {
  rc = input !== null ? 64 : 1;
}
process.exit(rc);
