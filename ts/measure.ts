// Measurement, ported from src/loadguard-hook.c (slurp, meminfo, avg10,
// read_pressure, zram_fill, psi_some). `root` prefixes every path: "" in
// production, a fixture tree in the test driver.
import { closeSync, constants, openSync, readdirSync, readSync } from "node:fs";
import { type Bytes, cstr, fromBuffer, int32, number, pathOf, strtod, u64 } from "./bytes.js";

export const PATH_MAX = 4096;

/** At most size - 1 bytes of the file root+path; null if it cannot be read. */
export function slurp(root: Bytes, path: Bytes, size: number): Bytes | null {
  const full = root + path;
  if (full.length >= PATH_MAX) return null;
  let fd: number;
  try {
    fd = openSync(pathOf(full), constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(size - 1);
    let total = 0;
    while (total < size - 1) {
      const r = readSync(fd, buf, total, size - 1 - total, null);
      if (r === 0) break;
      total += r;
    }
    return fromBuffer(buf.subarray(0, total));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The names in root+path, or null if it is no readable directory. */
export function listDir(root: Bytes, path: Bytes): Bytes[] | null {
  const full = root + path;
  if (full.length >= PATH_MAX) return null;
  try {
    return readdirSync(pathOf(full), { encoding: "buffer" }).map((name) => fromBuffer(name));
  } catch {
    return null;
  }
}

/** The kB figure of a /proc/meminfo key ("SwapFree:") at a line start. */
function meminfo(buf: Bytes, key: Bytes): bigint | null {
  for (let p = buf.indexOf(key); p >= 0; p = buf.indexOf(key, p + key.length))
    if (p === 0 || buf[p - 1] === "\n") return number(buf, p + key.length);
  return null;
}

/** The avg10 figure of a PSI line ("full avg10=") in %, -1 if missing. */
function avg10(buf: Bytes, key: Bytes): number {
  const p = buf.indexOf(key);
  if (p < 0) return -1;
  const [v, end] = strtod(buf, p + key.length);
  return end !== p + key.length && v >= 0 && v <= 100 ? v : -1;
}

export interface Pressure {
  /** memory PSI full avg10 in %, -1: unknown */
  full: number;
  /** all swap used in %, -1: unknown or no swap */
  swap: number;
}

export function readPressure(root: Bytes): Pressure {
  const pr: Pressure = { full: -1, swap: -1 };
  let buf = slurp(root, "/proc/pressure/memory", 8192);
  if (buf !== null && buf.length > 0) pr.full = avg10(cstr(buf), "full avg10=");
  buf = slurp(root, "/proc/meminfo", 8192);
  if (buf !== null && buf.length > 0) {
    const text = cstr(buf);
    const total = meminfo(text, "SwapTotal:");
    const avail = total === null ? null : meminfo(text, "SwapFree:");
    if (total !== null && avail !== null && total > 0n && avail <= total)
      pr.swap = int32(u64((total - avail) * 100n) / total);
  }
  return pr;
}

/** Memory PSI some avg10 in %, -1 if unknown. Info: the hook uses full. */
export function psiSome(root: Bytes): number {
  const buf = slurp(root, "/proc/pressure/memory", 8192);
  return buf !== null && buf.length > 0 ? avg10(cstr(buf), "some avg10=") : -1;
}

/** Data stored in all zram devices, % of their size; -1 if none. Info only. */
export function zramFill(root: Bytes): number {
  if ((root + "/sys/block").length >= PATH_MAX) return -1;
  const names = listDir(root, "/sys/block");
  if (names === null) return -1;
  let size = 0n, data = 0n;
  for (const name of names) {
    if (!name.startsWith("zram")) continue;
    let buf = slurp(root, "/sys/block/" + name + "/disksize", 256);
    const s = buf !== null && buf.length > 0 ? number(cstr(buf)) : null;
    if (s === null || s === 0n) continue; // never initialised
    buf = slurp(root, "/sys/block/" + name + "/mm_stat", 256);
    const d = buf !== null && buf.length > 0 ? number(cstr(buf)) : null;
    if (d === null) continue;
    size = u64(size + s);
    data = u64(data + d);
  }
  return size !== 0n ? int32(u64(data * 100n) / size) : -1;
}
