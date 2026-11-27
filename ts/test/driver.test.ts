// The bundled test driver, dist/driver.js, against the payload fixtures the C
// driver's Extraction tests use (t/test_hook_binary.py).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = join(ROOT, "t", "fixtures");
const DRIVER = join(ROOT, "dist", "driver.js");

// A command with everything the extraction must carry over byte for byte.
const NASTY =
  "cd '/tmp/a b' && cat <<'EOF' > \"out file\"\n" +
  "'single' \"double\" `backtick` $HOME ${X:-y} \\ \\\\ \\n \\\"\n" +
  "EOF\n" +
  "printf '%s\\n' \"ü € 😀    \" | sed 's/\\t/ /g'; " +
  "echo \x01\x1b[31m\x7f\t\r done; (exit 3) || true";

function fixture(name: string): Promise<Uint8Array> {
  return Bun.file(join(FIXTURES, name)).bytes();
}

function bashPayload(toolInput: unknown, asciiOnly = true): Uint8Array {
  let text = JSON.stringify({
    session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: toolInput, tool_use_id: "toolu_x",
  });
  if (asciiOnly)
    text = text.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return new TextEncoder().encode(text);
}

// The bundle as the starters run it: absolute Bun, no project config.
function driver(args: string[], stdin: Uint8Array) {
  const env = { ...process.env };
  delete env["BUN_OPTIONS"];
  const proc = Bun.spawnSync(
    [process.execPath, "--no-install", "--config=/dev/null", "--no-env-file", DRIVER, ...args],
    { stdin, env },
  );
  return { rc: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("command", () => {
  test("a Bash command is extracted", async () => {
    expect(driver(["command"], await fixture("bash-plain.json"))).toMatchObject({ rc: 0, stdout: "pwd" });
    const heredoc = await fixture("bash-heredoc.json");
    const want = JSON.parse(new TextDecoder().decode(heredoc)).tool_input.command;
    expect(driver(["command"], heredoc)).toMatchObject({ rc: 0, stdout: want });
  });

  test("a nasty command is extracted verbatim", () => {
    for (const asciiOnly of [true, false])
      expect(driver(["command"], bashPayload({ command: NASTY }, asciiOnly))).toMatchObject({ rc: 0, stdout: NASTY });
  });

  test("anything but a Bash command exits 1 silently", async () => {
    const inputs = [
      ...(await Promise.all(["read-tool.json", "bash-no-command.json", "not-an-object.json",
        "broken.json", "invalid-utf8.json", "empty.json"].map(fixture))),
      bashPayload(null), bashPayload({ command: 7 }),
      new TextEncoder().encode('{"tool_name": "bash", "tool_input": {"command": "ls"}}'),
      new Uint8Array([0x7b, 0x7d, 0x00]),
    ];
    for (const stdin of inputs) expect(driver(["command"], stdin)).toMatchObject({ rc: 1, stdout: "" });
  });

  test("above 8 MiB the payload is not parsed", () => {
    const big = bashPayload({ command: "x".repeat((8 << 20) - 200) });
    expect(driver(["command"], big).rc).toBe(0);
    expect(driver(["command"], bashPayload({ command: "x".repeat(9 << 20) }))).toMatchObject({ rc: 1, stdout: "" });
  });
});

describe("usage", () => {
  test("an unknown mode exits 64 with a Bash payload, 1 without", async () => {
    expect(driver(["nope"], await fixture("bash-plain.json")).rc).toBe(64);
    expect(driver([], await fixture("bash-plain.json")).rc).toBe(64);
    expect(driver(["nope"], await fixture("read-tool.json")).rc).toBe(1);
  });
});
