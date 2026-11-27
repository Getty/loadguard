// The hook payload, ported from src/loadguard-hook.c (read_stdin, valid_utf8,
// parse_payload, bash_tool_input). Fail open: anything unreadable is null.
import { type Bytes, fromBuffer, validUtf8 } from "./bytes.js";
import { get, type JValue, parse, str } from "./cjson.js";

/** Larger payloads pass through unparsed (MAX_PAYLOAD in the C hook). */
export const MAX_PAYLOAD = 8 << 20;

/** All of a stream, or null above MAX_PAYLOAD; the rest is drained so the writer never gets EPIPE. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size <= MAX_PAYLOAD) parts.push(chunk);
  }
  if (size > MAX_PAYLOAD) return null;
  const buf = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    buf.set(part, at);
    at += part.length;
  }
  return buf;
}

/** The payload as a JSON tree; null unless it is one UTF-8 JSON text without NUL bytes. */
export function parsePayload(buf: Uint8Array): JValue | null {
  const text = fromBuffer(buf);
  if (!validUtf8(text)) return null;
  // length + 1 takes in the terminating NUL: nothing may follow the text.
  return parse(text + "\0", text.length + 1, true)?.value ?? null;
}

/** tool_input of a Bash payload whose command is a string, else null. */
export function bashToolInput(payload: JValue | null): JValue | null {
  if (payload === null || payload.t !== "obj") return null;
  if (str(get(payload, "tool_name")) !== "Bash") return null;
  const input = get(payload, "tool_input");
  if (input === null || input.t !== "obj" || str(get(input, "command")) === null) return null;
  return input;
}

/** tool_input.command of a Bash payload, else null. */
export function bashCommand(payload: JValue | null): Bytes | null {
  return str(get(bashToolInput(payload), "command"));
}
