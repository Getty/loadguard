// The matcher, the shell wrappers and the C formatting, in process: the
// tables of t/test_throttle.py (Matcher) and t/test_learn.py (Extract).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fixed, general, utf8Bytes } from "../bytes.js";
import { Harness, heavyCommand, shellCommand } from "../classify.js";
import { get, parse, print, str } from "../cjson.js";
import { FIXTURES } from "./helpers.js";

const HEAVY: Record<string, string> = {
  "prove -lr t/": "prove",
  "/usr/bin/prove -l t/foo.t": "prove",
  "perl /usr/bin/prove -lr t": "prove",
  "cd ~/dev/x && prove -lr t/": "prove",
  "git pull; prove -lr t/": "prove",
  "ls || prove": "prove",
  "echo start\nprove -lr t/": "prove",
  "FOO=1 BAR=2 prove -l t/a.t": "prove",
  "env -i PATH=/usr/bin prove": "prove",
  "nice -n 10 make test": "make test",
  "timeout 10m cargo test": "cargo test",
  "xargs -P4 prove": "prove",
  "( cd x && prove )": "prove",
  "echo $(prove -l t/x.t)": "prove",
  "echo `make test`": "make test",
  "prove -lr t 2>&1 | tee log": "prove",
  "if make test; then echo ok; fi": "make test",
  "'prove' -l t": "prove",
  "make TEST_VERBOSE=1 test": "make test",
  "dzil release": "dzil release",
  "dzil build": "dzil build",
  "cpanm --installdeps .": "cpanm",
  "podman --remote run x": "podman run",
  "cargo +nightly test": "cargo test",
  "npm test": "npm test",
  "~/bin/perlbench --all": "perlbench",
  "claude -p 'fix the tests'": "claude -p",
  "claude --bg 'refactor'": "claude --bg",
  "codex -m gpt-6-astra exec --full-auto 'go'": "codex exec",
  "codex e 'fix the tests'": "codex e",
  "codex -c model=o3 review --base main": "codex review",
  "cat > x.sh <<-EOF\n\tprove\n\tEOF\nmake test": "make test",
  "cat <<A <<B\nprove\nA\nprove\nB\ncpanm X": "cpanm",
  "echo hi \\\n; prove": "prove",
  ["x".repeat(100000) + "; prove"]: "prove", // a word past WORD_MAX
  "prove; \x01 ä \u{1F600}": "prove",
};

const LIGHT = [
  "", "   ", "pwd", "git status", "loadguard status", "git log --grep=prove",
  "grep -rn 'make test' .", "echo prove", "which prove", "echo 'a; prove'",
  'git commit -m "fix; make test"', "cat > x.sh <<'EOF'\nprove -lr t\nmake test\nEOF\necho done",
  "cat <<EOF", "cat <<EOF\nprove", "ls # ; prove", "make", "make install", "dzil listdeps",
  "docker ps", "cargo check", "npm run lint", "claude --version", "codex", "codex resume --last",
  "codex-linux-sandbox --sandbox-policy-cwd /w -- /bin/bash -c prove", "perl -Ilib t/foo.t",
  "perl -e 'print 1'", "bash -c 'prove -lr t'", "sudo prove", "echo x > prove", "cat <<< prove",
  "nice", "env", "FOO=1", "make " + "V=1 ".repeat(40) + "test", "\x01prove", "'unterminated; prove",
  "\\", "<<", "<<-", "&", "'",
];

describe("heavyCommand", () => {
  test("heavy commands carry their label", () => {
    for (const [command, label] of Object.entries(HEAVY))
      expect([command.slice(0, 40), heavyCommand(utf8Bytes(command))?.label]).toEqual([command.slice(0, 40), label]);
  });

  test("light commands, quotes, comments and heredoc bodies are no command", () => {
    for (const command of LIGHT) expect([command, heavyCommand(utf8Bytes(command))]).toEqual([command, null]);
  });
});

interface ShellCase { case: string; command: string; argv: string[] }

async function recorded(name: string): Promise<ShellCase[]> {
  const doc = await Bun.file(join(FIXTURES, "shells", name + ".json")).json() as { cases: ShellCase[] };
  return doc.cases;
}

describe("shellCommand", () => {
  test("every recorded Claude Code wrapper gives back the command byte for byte", async () => {
    const cases = await recorded("claude-code");
    expect(cases.length).toBe(10);
    for (const c of cases)
      for (const h of [Harness.CLAUDE, Harness.ANY])
        expect([c.case, shellCommand(c.argv.map(utf8Bytes), h)]).toEqual([c.case, utf8Bytes(c.command)]);
  });

  test("Codex: argv[2] itself, never for the Claude Code form alone", async () => {
    for (const c of await recorded("codex")) {
      const av = c.argv.map(utf8Bytes);
      expect(shellCommand(av, Harness.CODEX)).toBe(utf8Bytes(c.command));
      expect(shellCommand(av, Harness.ANY)).toBe(utf8Bytes(c.command));
      expect(shellCommand(av, Harness.CLAUDE)).toBeNull();
    }
  });

  test("not a shell with code, not the wrapper", () => {
    expect(shellCommand(["/usr/bin/perl", "-e", "x"], Harness.ANY)).toBeNull();
    expect(shellCommand(["bash", "-x", "x"], Harness.ANY)).toBeNull();
    expect(shellCommand(["bash", "-c", "eval 'x' && pwd -P >| /tmp/a"], Harness.CLAUDE)).toBeNull();
    expect(shellCommand(["bash", "-c", "eval \"$x\" && pwd -P >| /tmp/a-cwd"], Harness.CLAUDE)).toBeNull();
    expect(shellCommand(["bash", "-c", "eval 'a'\\''b' && pwd -P >| /tmp/a-cwd"], Harness.CLAUDE)).toBe("a'b");
  });
});

describe("C formatting", () => {
  test("printf %.Nf rounds the exact value, ties to even", () => {
    expect([fixed(10.25, 1), fixed(12.75, 1), fixed(0.125, 2), fixed(2.5, 0), fixed(59.94, 1)])
      .toEqual(["10.2", "12.8", "0.12", "2", "59.9"]);
    expect([fixed(-0, 2), fixed(-1, 2), fixed(Infinity, 1)]).toEqual(["-0.00", "-1.00", "inf"]);
  });

  test("printf %g as cJSON prints numbers", () => {
    expect([general(59.94, 15), general(1e-5, 15), general(1e21, 15), general(0.1 + 0.2, 17), general(100, 15)])
      .toEqual(["59.94", "1e-05", "1e+21", "0.30000000000000004", "100"]);
  });

  test("cJSON reading: first duplicate key, no lone surrogate, NUL ends a string", () => {
    const read = (s: string) => parse(s + "\0", s.length + 1, true)?.value ?? null;
    expect(str(get(read('{"a":"x","a":"y"}'), "a"))).toBe("x");
    expect(read('{"a":"\\ud800"}')).toBeNull();
    expect(str(get(read('{"a":"\\ud83d\\ude00"}'), "a"))).toBe(utf8Bytes("\u{1F600}"));
    expect(str(get(read('{"a":"x\\u0000y"}'), "a"))).toBe("x");
    expect(read("\x01{}\x0b")).not.toBeNull();
    expect(read("[".repeat(1001) + "]".repeat(1001))).toBeNull();
    expect(print(read('{"a":[1,2.5,-0,1e999,"\\u0001"]}') ?? { t: "null" })).toBe('{"a":[1,2.5,0,null,"\\u0001"]}');
  });
});
