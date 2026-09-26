---
name: loadguard-core
description: Use when changing loadguard's hook, CLI, thresholds or tests — the hook contract, the measurement sources, the systemd scope wrapping and the invariants that keep a guard on every Bash call cheap and safe.
user-invocable: false
---

# loadguard — core

loadguard is a Claude Code plugin: a `PreToolUse` hook on `Bash` that confines, limits
and, under pressure, refuses AI-issued shell commands, and tells the model why. Design
and rationale: `docs/design.md`. This skill holds what an implementer must not get
wrong.

## Hook contract (Claude Code)

- Input: JSON on stdin — `hook_event_name`, `session_id`, `cwd`, `tool_name`,
  `tool_input.command`, `tool_input.run_in_background`, …
- Output on stdout, exit 0:
  `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision":
  "allow"|"deny"|"ask", "permissionDecisionReason": "…", "updatedInput": {…}}}`.
  `updatedInput` **replaces** `tool_input`, no merge (recorded k7, Claude Code
  2.1.283, `t/test_updated_input.py`): a key left out is gone. Copy every key of
  the incoming `tool_input` — only those the model set are there — and change
  `command`. It takes effect without `permissionDecision`; the rewritten command
  ran although only the original matched `--allowedTools`.
- The deny reason is shown to the model. It is loadguard's only voice: short,
  numbers, one concrete alternative.
- Field names drift between Claude Code versions. Before relying on one, confirm it
  against https://code.claude.com/docs/en/hooks (or ask the `claude-code-guide`
  agent) and pin what you verified in a test fixture.
- `allow` skips the user's permission prompt. loadguard must never grant what the
  user's settings would not: when rewriting without an opinion on permission, omit
  `permissionDecision` rather than sending `allow`.

## Invariants

1. **Fail open.** Any internal error, unreadable `/proc` file, missing systemd →
   pass the command through untouched and exit 0. A broken guard must never brick
   every session on the host.
2. **Cheap.** Runs before every Bash call of every session. No subprocess in the
   normal path (read `/proc` directly — no `jq`, `ps`, `free`), target < 30 ms.
   The hook path is C with vendored cJSON (Python startup alone costs ~180 ms on
   reuben); CLI and tests are Python stdlib. No binary yet → pass through.
3. **Light commands are never refused.** The model must always be able to look
   (`git status`, `ls`, `cat`, `karr show`, `loadguard status`).
4. **The wrap is transparent.** Exit code, stdout/stderr, working directory, env and
   `run_in_background` behave as without loadguard. Quoting of the original command
   is the dangerous part — test heredocs, quotes, `&&` chains, `cd`, subshells.
   The user's permission rules are checked against the *original* command (k7), so
   a rewrite is never re-vetted: loadguard may only wrap, never change what runs.
5. **Zero context cost when calm.** No SessionStart/UserPromptSubmit output unless
   pressure is elevated.

## Measurement sources (Linux)

| Source | Holds |
|---|---|
| `/proc/pressure/{memory,io,cpu}` | `some`/`full avg10 avg60 avg300 total` — PSI, the primary signal |
| `/proc/meminfo` | `MemAvailable`, `SwapTotal`, `SwapFree` (total swap: zram + swapfile) |
| `/proc/loadavg` | load — secondary, misleading with D-state pile-ups |
| `/sys/fs/cgroup/<scope>/memory.peak`, `memory.events` | what a finished wrapped command actually used / whether it hit `oom_kill` |

`cpu some` is routinely high on reuben and is not an emergency on its own. Memory
`full avg10` (primary) and total swap fill (secondary) precede the thrash reboots;
zram fill alone does not — zram0 sits at ~98 % when calm (the swapfile takes the
overflow).

## Confinement

`systemd-run --user --scope -q -p MemoryHigh= -p MemoryMax= -p MemorySwapMax=
-p CPUWeight= -p IOWeight= -- …` — verified working on reuben (memory controller
delegated to `user@1000.service`). Check delegation once per boot
(`/sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`),
cache the answer under `$XDG_RUNTIME_DIR/loadguard/`.

## Testing

Unit-test the decision function on recorded snapshots: turn files from
`~/load-incidents/` into fixtures (PSI + meminfo + command → expected decision).
Never generate real memory pressure on reuben to test — it is the machine this
plugin protects, and it has 8 GB.
