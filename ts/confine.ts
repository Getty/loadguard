// SessionStart: confine the session (k3, stage 1) and start the scope's
// watcher (k15); the Bun entry of hooks/loadguard-confine, bundled to
// dist/confine.js. Logic: ts/scope.ts.
//
//   confine.js            as a hook: payload on stdin (plain JSON for now;
//                         the SDK codec entry comes with B4)
//   confine.js --status   same, print confine's status word (debugging)
//
// Prints nothing else (zero context cost) and exits 0 whatever happens: the
// session always starts, confined or not. As in the Python hook, a payload
// that is no UTF-8 JSON object only loses the session id; any other error
// ends the hook at once, without a watcher.
import { confine, startWatcher } from "./scope.js";

async function main(): Promise<void> {
  const raw = new Uint8Array(await Bun.stdin.arrayBuffer());
  let sessionId: string | null = null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const id = (payload as Record<string, unknown>)["session_id"];
      sessionId = typeof id === "string" ? id : null;
    }
  } catch {
    sessionId = null;
  }
  const status = confine(sessionId);
  if (process.argv[2] === "--status") await Bun.write(Bun.stdout, status + "\n");
  startWatcher(status);
}

try {
  await main();
} catch {
  // never fail a session start
}
process.exit(0);
