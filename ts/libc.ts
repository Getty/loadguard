// libc through bun:ffi, loaded once and only when needed: flock() for the
// watcher's locks (ts/lock.ts) and getpwuid() for the linger check
// (ts/scope.ts) — Bun's os.userInfo() takes the name from $USER — and
// strerror() for the CLI's error texts (ts/learnlist.ts). null where
// libc.so.6 cannot be loaded (bun:ffi is experimental in Bun, musl has no
// libc.so.6): the callers fall back.
import { CString, dlopen, FFIType, read } from "bun:ffi";

export interface Libc {
  flock(fd: number, op: number): number;
  /** pw_name of getpwuid(uid); null without an entry */
  userName(uid: number): string | null;
  /** strerror(errno): the C library's text, as Python's OSError.strerror */
  strerror(errno: number): string;
}

let libc: Libc | null | undefined;

export function loadLibc(): Libc | null {
  if (libc !== undefined) return libc;
  try {
    const lib = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      getpwuid: { args: [FFIType.u32], returns: FFIType.ptr },
      strerror: { args: [FFIType.i32], returns: FFIType.cstring },
    });
    libc = {
      flock: (fd, op) => lib.symbols.flock(fd, op) as number,
      userName: (uid) => {
        const pw = lib.symbols.getpwuid(uid);
        if (pw === null) return null;
        const name = read.ptr(pw, 0); // struct passwd: char *pw_name first
        return name === 0 ? null : new CString(name as never).toString();
      },
      strerror: (errno) => String(lib.symbols.strerror(errno)),
    };
  } catch {
    libc = null;
  }
  return libc;
}
