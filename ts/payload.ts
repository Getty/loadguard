// The hook payload, ported from src/loadguard-hook.c (read_stdin, valid_utf8,
// parse_payload, bash_tool_input). Fail open: anything unreadable is null.

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

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The payload as a JSON value; null unless it is one UTF-8 JSON text without NUL bytes. */
export function parsePayload(buf: Uint8Array): unknown {
  if (buf.includes(0)) return null;
  try {
    return JSON.parse(utf8.decode(buf));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** tool_input of a Bash payload whose command is a string, else null. */
export function bashToolInput(payload: unknown): Record<string, unknown> & { command: string } | null {
  if (!isObject(payload) || payload["tool_name"] !== "Bash") return null;
  const input = payload["tool_input"];
  if (!isObject(input) || typeof input["command"] !== "string") return null;
  return input as Record<string, unknown> & { command: string };
}
