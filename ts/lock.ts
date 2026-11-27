// flock(2) for the watcher: one watcher per scope (LOCK_EX|LOCK_NB on
// <scope>.watch) and the writers of the learned list (LOCK_EX on
// learned.lock), the same locks the C watcher and `loadguard forget`
// (Python fcntl.flock) take, so all of them keep writing alongside.
//
// libc's flock() through bun:ffi (ts/libc.ts); where that cannot be loaded,
// flock(1) from util-linux on the same open file: it gets the descriptor as
// its fd 3, and a flock lock belongs to the open file, so it outlives
// flock(1)'s exit and is released when this process closes the descriptor.
import { spawnSync } from "node:child_process";
import { loadLibc } from "./libc.js";

const LOCK_EX = 2;
const LOCK_NB = 4;

let forced: "ffi" | "flock1" | null = null;

function flock1(fd: number, nonBlocking: boolean): boolean {
  try {
    const r = spawnSync("flock", nonBlocking ? ["-x", "-n", "3"] : ["-x", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** An exclusive flock on fd; with nonBlocking, false at once if it is held. */
export function lockFile(fd: number, nonBlocking: boolean): boolean {
  const libc = forced === "flock1" ? null : loadLibc();
  if (libc !== null) return libc.flock(fd, LOCK_EX | (nonBlocking ? LOCK_NB : 0)) === 0;
  return forced === "ffi" ? false : flock1(fd, nonBlocking);
}

/** Tests: pin one way ("ffi" fails without it), or null for the default. */
export function forceLockImpl(impl: "ffi" | "flock1" | null): void {
  forced = impl;
}
