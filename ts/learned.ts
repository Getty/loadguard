// The learned list (k15), the reading half: ported from src/loadguard-hook.c
// (learn_off, state_file, read_regular, parse_lesson, each_lesson,
// keep_lesson, load_lessons, lesson_for, human_size, lesson_label, cut).
// Written by the watcher and `loadguard forget`, never here.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { type Bytes, fit, fixed, fromBuffer, isDigit, isSpace, pathOf } from "./bytes.js";
import { get, parse, str } from "./cjson.js";
import { getenv } from "./env.js";
import { PATH_MAX } from "./measure.js";

const LEARNED_FILE = "learned.jsonl";
const LEARNED_BYTES = 1 << 20; // larger: ignored, as if empty
const LEARNED_LINES = 256;     // lines read at most

export type LearnState = "off" | "none" | "ok" | "too-large" | "unreadable";

export interface Lesson {
  command: Bytes;
  /** bytes, -1 unknown */
  peak: number;
  /** date last seen big, "" unknown */
  last: Bytes;
}

/** LOADGUARD_LEARN=0, only that exact value: no watcher, list ignored. */
export function learnOff(): boolean {
  return getenv("LOADGUARD_LEARN") === "0";
}

/**
 * ${XDG_STATE_HOME:-$HOME/.local/state}/loadguard/<name>; null without an
 * absolute path for either (the XDG spec ignores a relative one).
 */
export function stateFile(name: Bytes): Bytes | null {
  const xdg = getenv("XDG_STATE_HOME"), home = getenv("HOME");
  let path: Bytes;
  if (xdg !== null && xdg[0] === "/") path = xdg + "/loadguard/" + name;
  else if (home !== null && home[0] === "/") path = home + "/.local/state/loadguard/" + name;
  else return null;
  return path.length < PATH_MAX ? path : null;
}

/**
 * A regular file of at most max bytes; else null and why. O_NONBLOCK and the
 * fstat keep a FIFO planted in its place from blocking the hook.
 */
function readRegular(path: Bytes, max: number): { buf: Bytes | null; state: LearnState } {
  let fd: number;
  try {
    fd = openSync(pathOf(path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (e) {
    return { buf: null, state: (e as { code?: string }).code === "ENOENT" ? "none" : "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { buf: null, state: "unreadable" };
    if (st.size > max) return { buf: null, state: "too-large" };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = readSync(fd, buf, n, st.size - n, null);
      if (r === 0) break;
      n += r;
    }
    return { buf: fromBuffer(buf.subarray(0, n)), state: "ok" };
  } catch {
    return { buf: null, state: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/** One line of the list as a lesson, if it is a JSON object with a string "command". */
function parseLesson(line: Bytes): Lesson | null {
  const r = parse(line, line.length, false);
  if (r === null) return null;
  let end = r.end;
  while (end < line.length && isSpace(line[end])) end++;
  const command = str(get(r.value, "command"));
  if (end !== line.length || r.value.t !== "obj" || command === null) return null;
  const peak = get(r.value, "peak_rss"), last = str(get(r.value, "last_seen"));
  let date = "";
  // The date goes into a reason: only YYYY-MM-DD.
  if (last !== null && last.length >= 10) {
    let i = 0;
    for (; i < 10; i++)
      if (i === 4 || i === 7 ? last[i] !== "-" : !isDigit(last[i])) break;
    if (i === 10) date = last.slice(0, 10);
  }
  return { command, peak: peak !== null && peak.t === "num" && peak.v > 0 ? peak.v : -1, last: date };
}

let loaded: { state: LearnState; lessons: Lesson[] } | null = null;

/** The list, read once per run; nothing while learning is off. */
export function loadLessons(): { state: LearnState; lessons: Lesson[] } {
  if (loaded !== null) return loaded;
  loaded = { state: "off", lessons: [] };
  if (learnOff()) return loaded;
  loaded.state = "none";
  const path = stateFile(LEARNED_FILE);
  if (path === null) return loaded;
  const { buf, state } = readRegular(path, LEARNED_BYTES);
  loaded.state = state;
  if (buf === null) return loaded;
  let lines = 0;
  for (let line = 0; line < buf.length && lines < LEARNED_LINES; lines++) {
    let end = buf.indexOf("\n", line);
    if (end < 0) end = buf.length;
    const lesson = parseLesson(buf.slice(line, end));
    if (lesson !== null) loaded.lessons.push(lesson);
    line = end + 1;
  }
  return loaded;
}

export function learnedFile(): Bytes | null {
  return stateFile(LEARNED_FILE);
}

export function lessonFor(command: Bytes): Lesson | null {
  return loadLessons().lessons.find((l) => l.command === command) ?? null;
}

/** "3.2 GiB", "640 MiB" */
function humanSize(bytes: number): Bytes {
  return bytes >= 1073741824 ? fixed(bytes / 1073741824, 1) + " GiB" : fixed(bytes / 1048576, 0) + " MiB";
}

/** "learned: peaked at 3.2 GiB RSS on 2026-09-21", in size bytes. */
export function lessonLabel(ls: Lesson, size: number): Bytes {
  let label = fit("learned", size);
  if (ls.peak > 0) label += fit(": peaked at " + fit(humanSize(ls.peak), 32) + " RSS", size - label.length);
  if (ls.last !== "") label += fit(" on " + ls.last, size - label.length);
  return label;
}

/** s cut to fit size bytes, with "..." at a character boundary. */
export function cut(s: Bytes, size: number): Bytes {
  if (s.length < size) return s;
  let n = size - 4;
  while (n > 0 && (s.charCodeAt(n) & 0xc0) === 0x80) n--;
  return s.slice(0, n) + "...";
}
