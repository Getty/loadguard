// @bun
// ts/payload.ts
var MAX_PAYLOAD = 8 << 20;
async function readAll(stream) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size <= MAX_PAYLOAD)
      parts.push(chunk);
  }
  if (size > MAX_PAYLOAD)
    return null;
  const buf = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    buf.set(part, at);
    at += part.length;
  }
  return buf;
}
var utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function parsePayload(buf) {
  if (buf.includes(0))
    return null;
  try {
    return JSON.parse(utf8.decode(buf));
  } catch {
    return null;
  }
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function bashToolInput(payload) {
  if (!isObject(payload) || payload["tool_name"] !== "Bash")
    return null;
  const input = payload["tool_input"];
  if (!isObject(input) || typeof input["command"] !== "string")
    return null;
  return input;
}

// ts/driver.ts
var buf = await readAll(Bun.stdin.stream());
var input = bashToolInput(buf === null ? null : parsePayload(buf));
var args = process.argv.slice(2);
var rc = 0;
if (args.length === 1 && args[0] === "command") {
  if (input === null)
    rc = 1;
  else if (input.command !== "")
    await Bun.write(Bun.stdout, input.command);
} else {
  rc = input !== null ? 64 : 1;
}
process.exit(rc);
