// The watcher of a session scope (k15), the Bun entry of the C hook's
// `--watch PID`, bundled to dist/watch.js; started detached by
// dist/confine.js. Logic: ts/watcher.ts.
//
//   watch.js PID    until the session process PID is gone; prints nothing,
//                   exits 0 whatever happens
import { watch } from "./watcher.js";

const args = process.argv.slice(2);
try {
  if (args.length === 1) watch(args[0] as string);
} catch {
  // a watcher never fails anything
}
process.exit(0);
