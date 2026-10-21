---
name: loadguard-harness
description: Use when changing loadguard's hook payloads, plugin manifests or harness adapters — Claude Code hook contract, Codex plugin (k11), shell wrappers.
user-invocable: false
---

# loadguard — harness adapters

loadguard runs under two harnesses. The decision is the same everywhere; the
protocol is not. This skill holds the per-harness wire format: payload shapes,
event names, sandbox and trust quirks, the shell wrappers.

- **Claude Code** — the reference. `hooks/hooks.json` registers the events,
  `hooks/loadguard` is the sh starter that `exec`s the C binary (without the
  binary it exits 0).
- **Codex (k11)** — `.codex-plugin/plugin.json` = `.claude-plugin/plugin.json`
  plus `hooks`; the same `hooks/hooks.json` does the work.

Details and file:line: `docs/design.md` (Codex, k11).

## Claude Code

- Input: JSON on stdin — `hook_event_name`, `session_id`, `cwd`, `tool_name`,
  `tool_input.command`, `tool_input.run_in_background`, …
- Output on stdout, exit 0:
  `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision":
  "allow"|"deny"|"ask", "permissionDecisionReason": "…", "updatedInput": {…}}}`.
  `updatedInput` **replaces** `tool_input`, no merge (recorded k7, Claude Code
  2.1.283, `t/test_updated_input.py`): a key left out is gone. Copy every key of
  the incoming `tool_input` — only those the model set are there — and change
  `command`. It takes effect without `permissionDecision`. Permission rules are
  checked against the **rewritten** command (k3, live): a rewrite breaks the
  user's allow rules. k7's opposite reading came from `echo`, which is auto-approved.
- The deny reason is shown to the model. With the context line it is loadguard's
  only voice: short, numbers, one concrete alternative. Print the JSON without a
  trailing newline (the form k7 recorded working).
- `UserPromptSubmit`/`SessionStart` (k6): same starter and binary, branching on
  `hook_event_name`. Output `{"hookSpecificOutput": {"hookEventName": "<event>",
  "additionalContext": "…"}}` — a system reminder next to the prompt / before
  the first one. Plain stdout reaches the context too, but Codex (k11) rejects
  unknown top-level keys: only `hookSpecificOutput`. Synchronous: async context
  arrives a turn late and `-p` kills it. Exit 2 on UserPromptSubmit blocks and
  erases the user's prompt — never. State facts, not orders: text framed as
  system instructions can trip prompt-injection defenses (docs).
- A timed-out hook does **not** block the command (docs, checked k4): a slow hook
  is a pass-through, so the deny path must be the fast one.
- Field names drift between Claude Code versions. Before relying on one, confirm it
  against https://code.claude.com/docs/en/hooks (or ask the `claude-code-guide`
  agent) and pin what you verified in a test fixture.
- `allow` skips the user's permission prompt. loadguard must never grant what the
  user's settings would not: when rewriting without an opinion on permission, omit
  `permissionDecision` rather than sending `allow`.
- Every call runs as
  `bash -c 'source <snapshot> && eval <cmd> && pwd -P >| <cwd-file>'`: a child
  shell loses `cd` and snapshot functions (k3, live) — that is why the hook
  never rewrites the command. The wrapper (Claude Code 2.1.283, recorded in
  `t/fixtures/shells/`) is
  `… && eval '<cmd>'[ < /dev/null] && pwd -P >| /tmp/claude-XXXX-cwd`, a quote
  written `'"'"'`; read the word as the shell would, anything else = unknown
  form, nothing learned.

## Codex (k11)

Verified against the codex-rs `rust-v0.153.4` sources (= `codex-cli 0.153.4`);
details and file:line in `docs/design.md` → Codex (k11).

- `.codex-plugin/plugin.json` = `.claude-plugin/plugin.json` + `hooks`; a test
  pins every shared field (bump both versions together).
- Codex drops `args`, substitutes `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`
  (and `PLUGIN_*`) in the command text and env, runs `<shell> -c <command>` with
  codex's own env, outside the sandbox. Every hook entry must work from
  `$CLAUDE_PLUGIN_DATA` alone (`CodexRuns`). Top level of hooks.json: only
  `description`/`hooks`. Output structs deny unknown fields.
- Shell tool → PreToolUse `tool_name: "Bash"`, `tool_input: {"command"}` only.
  Same deny JSON, same context JSON, same decision. Codex wraps a deny as
  `Command blocked by PreToolUse hook: {reason}. Command: {cmd}`, so its
  reason drops the final period; its context line drops "; see `loadguard
  status`" (k14, `codex_spelling()` in `CodexPayloads`). Claude Code's bytes
  never change (`test_claude_code_bytes_unchanged`).
- Harness (`from_codex()`, no file): `turn_id` string in the payload on
  PreToolUse/UserPromptSubmit (Codex extension, `schema.rs:280-281,
  569-570`); SessionStart has none (499-510), there `PLUGIN_ROOT` ==
  `CLAUDE_PLUGIN_ROOT` in the env (`discovery.rs:262-270`). No signal →
  Claude Code's form. Claude Code already has `turn_id` on MessageDisplay.
- `codex exec|e|review` = `K_AGENT` like `claude -p`: heavy to start, no slot
  (`review` is exec in its own process, `cli/src/main.rs:1160-1174`). Commands
  run codex → `codex-linux-sandbox` → bwrap → helper (comm `codex`, argv[0]
  `codex-linux-sandbox`) → `bash -c` → …: helpers are light and hide nothing
  (`procs/codex-session.json`).
- The call is found in argv[2], not in a shell wrapper (confirmed live
  2026-09-27, `t/fixtures/shells/codex.json`); bash 5.2 execs the last command
  of `-c`, so a lone Codex command has no shell — it is not learned, and it
  holds no slot as a learned one (documented, not rebuilt from argv).
- A shared `codex app-server` daemon hosts many threads: one scope for all
  (already-confined rule), never skipped.
- Plugin `bin/` is not on Codex's shell PATH; in its sandbox `/proc` is the
  sandbox's PID namespace. Hooks run only after the user trusts them (per
  handler; a changed hooks.json asks again; `codex exec` cannot grant it).
