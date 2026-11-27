// bin/loadguard (k5, k15), the Bun entry, bundled to dist/cli.js. Logic:
// ts/commands.ts.
//
//   cli.js status             memory pressure, heavy slots and who holds them
//   cli.js doctor             can loadguard work here; exit 1 if not
//   cli.js explain <command>  what the hook would do with it now, dry
//   cli.js explain            the same, the command on stdin
//   cli.js learned            the learned list
//   cli.js forget <n>...|all  drop learned commands
//   cli.js help
//
// Positional arguments only: under the getty-bun starter no entry argument
// begins with "-". Exit 0, 1 (a problem found or an error), 2 (usage).
import { main } from "./commands.js";

let rc = 1;
try {
  const r = await main(process.argv.slice(2), async () => new Uint8Array(await Bun.stdin.arrayBuffer()));
  if (r.stdout !== "") await Bun.write(Bun.stdout, r.stdout);
  if (r.stderr !== "") await Bun.write(Bun.stderr, r.stderr);
  rc = r.rc;
} catch (e) {
  await Bun.write(Bun.stderr, `loadguard: ${e instanceof Error ? e.message : String(e)}\n`);
}
process.exit(rc);
