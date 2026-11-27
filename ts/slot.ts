// The getty-bun slot as the starter would find it, for `loadguard doctor`:
// read-only, never installs. Mirrors bootstrap/getty-bun.sh `status` (the
// render of getty-bun-install): the store from GETTY_HOME or ~/.getty, the
// target from the machine (x64 without AVX2: linux-x64-baseline; musl and
// other systems unsupported), the slot <store>/runtimes/bun/<pin>/<target>,
// and its state — ready when receipt.json's first three lines name the pin
// and the target and bin/bun is a non-empty executable, missing when there
// is nothing at the slot path, mismatch otherwise.
//
// The pin is gettyBun.bunVersion of package.json, bundled in at build time;
// the starter's pin block carries the same version (getty-bun-install).
// `root` prefixes /proc and /lib for tests; "" in production.
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import type { Environ } from "./scope.js";

export const PIN: string = pkg.gettyBun.bunVersion;

export type SlotState = "ready" | "missing" | "mismatch";

export type Slot =
  | { slot: string; target: string; state: SlotState }
  | { error: string };

/** The store root, as the starter resolves it; or why the starter fails. */
function store(environ: Environ): { home: string } | { error: string } {
  let home: string;
  const getty = environ["GETTY_HOME"];
  if (getty !== undefined) {
    if (!getty.startsWith("/")) return { error: `GETTY_HOME must be an absolute path, got '${getty}'` };
    home = getty;
  } else {
    const h = environ["HOME"] ?? "";
    if (!h.startsWith("/")) return { error: "HOME is not an absolute path; set GETTY_HOME to an absolute path" };
    home = h + "/.getty";
  }
  if (/[\x00-\x1f\x7f]/.test(home)) return { error: "GETTY_HOME contains control characters" };
  while (home !== "/" && home.endsWith("/")) home = home.slice(0, -1);
  return { home };
}

/** has_avx2(): the first flags line of /proc/cpuinfo. */
function hasAvx2(root: string): boolean {
  let text: string;
  try {
    text = readFileSync(root + "/proc/cpuinfo", "latin1");
  } catch {
    return false;
  }
  for (const line of text.split("\n"))
    if (line.startsWith("flags") && line.includes(":"))
      return (" " + line.slice(line.indexOf(":") + 1) + " ").includes(" avx2 ");
  return false;
}

/** detect_target(): the starter's target name, or why it has none. */
function target(root: string, platform: string, arch: string): { target: string } | { error: string } {
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "aarch64" : arch;
  if (platform !== "linux") return { error: `unsupported target ${platform}-${a}` };
  const ld = a === "x64" ? "/lib64/ld-linux-x86-64.so.2" : a === "aarch64" ? "/lib/ld-linux-aarch64.so.1" : null;
  if (ld === null) return { error: `unsupported target linux-${a}` };
  if (!existsSync(root + ld)) {
    let musl: string | undefined;
    try {
      musl = readdirSync(root + "/lib").find((f) => /^ld-musl-.*\.so\.1$/.test(f));
    } catch {
      musl = undefined;
    }
    if (musl !== undefined) return { error: `unsupported target linux-${a}-musl (musl libc /lib/${musl}, no glibc ${ld})` };
  }
  return { target: a === "x64" && !hasAvx2(root) ? "linux-x64-baseline" : `linux-${a}` };
}

/** slot_state() */
function state(slot: string, pin: string, tgt: string): SlotState {
  let present = existsSync(slot);
  if (!present) {
    try {
      lstatSync(slot);
      present = true;
    } catch {
      present = false;
    }
  }
  if (!present) return "missing";
  try {
    const receipt = slot + "/receipt.json", bun = slot + "/bin/bun";
    if (!statSync(receipt).isFile() || !statSync(bun).isFile() || statSync(bun).size === 0) return "mismatch";
    accessSync(receipt, constants.R_OK);
    accessSync(bun, constants.X_OK);
    const lines = readFileSync(receipt, "utf8").split("\n");
    return lines[0] === "{" && lines[1] === `  "version": "${pin}",` && lines[2] === `  "target": "${tgt}",`
      ? "ready" : "mismatch";
  } catch {
    return "mismatch";
  }
}

/** The slot the starter would run the pinned Bun from, and its state. */
export function findSlot(environ: Environ, root = "", platform: string = process.platform,
                         arch: string = process.arch): Slot {
  const s = store(environ);
  if ("error" in s) return s;
  const t = target(root, platform, arch);
  if ("error" in t) return t;
  const slot = `${s.home === "/" ? "" : s.home}/runtimes/bun/${PIN}/${t.target}`;
  return { slot, target: t.target, state: state(slot, PIN, t.target) };
}
