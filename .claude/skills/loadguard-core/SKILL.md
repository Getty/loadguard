---
name: loadguard-core
description: Use when changing loadguard's hook, CLI, thresholds or tests — the hook contract, the measurement sources, the systemd scope wrapping and the invariants that keep a guard on every Bash call cheap and safe.
user-invocable: false
---

# loadguard — core

loadguard is a Claude Code plugin, and a Codex one from the same `hooks/hooks.json`
(k11): a `PreToolUse` hook on `Bash` that confines, limits and, under pressure,
refuses AI-issued shell commands, and tells the model why. Design and rationale:
`docs/design.md`. This skill holds what an implementer must not get wrong.

## Hook contract (Claude Code)

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
- The deny reason is shown to the model. With the context line (below) it is
  loadguard's only voice: short, numbers, one concrete alternative. Print the
  JSON without a trailing newline (the form k7 recorded working).
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

## Invariants

1. **Fail open.** Any internal error, unreadable `/proc` file, missing systemd →
   pass the command through untouched and exit 0. A broken guard must never brick
   every session on the host.
2. **Cheap.** Runs before every Bash call of every session. No subprocess in the
   normal path (read `/proc` directly — no `jq`, `ps`, `free`), target < 30 ms.
   The hook path is C with vendored cJSON (Python startup alone costs ~180 ms on
   reuben); CLI and tests are Python stdlib. No binary yet → pass through.
   A light command reads stdin and the learned list (k15: one `open`, none
   there = one failed `open`) — nothing else. Under memory pressure never read
   another process's `/proc/<pid>/cmdline`: it faults swapped pages in and can
   outlast the timeout — which lets the heavy command run.
3. **Light commands are never refused.** The model must always be able to look
   (`git status`, `ls`, `cat`, `karr show`, `loadguard status`).
4. **Commands are never rewritten.** Exit code, stdout/stderr, working directory,
   env, permissions and `run_in_background` behave as without loadguard — the hook
   only stays silent or denies. Claude Code runs each call as `bash -c 'source <snapshot> && eval <cmd> && pwd -P
   >| <cwd-file>'`: a child shell loses `cd` and snapshot functions (k3, live).
5. **Zero context cost when calm.** No SessionStart/UserPromptSubmit output unless
   pressure is elevated.

## Measurement sources (Linux)

| Source | Holds |
|---|---|
| `/proc/pressure/{memory,io,cpu}` | `some`/`full avg10 avg60 avg300 total` — PSI, the primary signal |
| `/proc/meminfo` | `MemAvailable`, `SwapTotal`, `SwapFree` (total swap: zram + swapfile) |
| `/proc/loadavg` | load — secondary, misleading with D-state pile-ups |
| `/proc/<pid>/{cgroup,stat,cmdline,cwd}` | slot scan: in `app-loadguard.slice`?, ppid (after the **last** `)` — comm holds spaces), argv, where |
| `/sys/fs/cgroup/<scope>/memory.peak`, `memory.events` | what a finished wrapped command actually used / whether it hit `oom_kill` |

`cpu some` is routinely high on reuben and is not an emergency on its own. Memory
`full avg10` (primary) and total swap fill (secondary) precede the thrash reboots;
zram fill alone does not — zram0 sits at ~98 % when calm (the swapfile takes the
overflow).

## Confinement

Stage 1 confines the **session**, not each command (decided 2026-09-26 after k3):
the SessionStart hook moves the session process — the nearest ancestor whose
comm or argv[0] is `claude` or `codex` (`find_session()`) — into a transient user scope with
`MemoryHigh`/`MemoryMax`/`MemorySwapMax`/`CPUWeight` (D-Bus `StartTransientUnit`,
`PIDs=`). Never rewrite commands for confinement — a rewrite breaks the user's
permission rules and loses `cd`. Verified on reuben: memory controller delegated to
`user@1000.service` (not `io`). Check delegation once per boot
(`/sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`),
cache the answer under `$XDG_RUNTIME_DIR/loadguard/`.

Implemented in `lib/loadguard/confine.py` (k3): scope
`app-loadguard.slice/loadguard-<session8>-<pid>.scope`, via `busctl` once per session.
`OOMPolicy=continue` is mandatory — the default `stop` kills claude along with the
outlier. Already in any `loadguard-*.scope` → do nothing (resume/compact, and a nested
`claude -p` must not escape its parent's limit). `PIDs=` holds claude alone (k12): a
PID that vanishes before systemd moves it fails the unit asynchronously while busctl
returns 0 — sibling SessionStart hooks do exactly that. Confirm via
`/proc/<claude>/cgroup`, then move older descendants with `AttachProcessesToUnit`
(synchronous, needs `Delegate=yes`; one gone PID fails the batch → per PID). No
second start: same name is "already loaded" until collected.

## Throttle (k4)

In `src/loadguard-hook.c`: heavy incoming command **and** (memory `full avg10` ≥
`LOADGUARD_PSI_FULL` 10 **or** swap used ≥ `LOADGUARD_SWAP_USED` 90 **or** running
heavy ≥ `LOADGUARD_HEAVY_SLOTS` `max(1, nproc/2)`) → deny. `LOADGUARD_THROTTLE=0`
→ pass-through. Thresholds come from the 54 snapshots (calm full ≤ 2.03 %, swap ≤
68 %; thrash full ≥ 45.47 %, swap ≥ 92 %); retune only against them
(`t/test_throttle.py` `Calibration`).

- Incoming: match in command position (after `;` `&&` `|` newline, `VAR=x`,
  `nice`/`timeout`/`env` …), never a substring — quotes, comments and heredoc
  bodies are not commands. Unsure → light.
- Running: judge argv, not text — argv[0] basename, an interpreter's script,
  never inline code (`bash -c`, `perl -e`: that is Claude Code's wrapper). Count
  only the topmost heavy process of a chain in the slice. `claude -p`/`--bg`
  and `codex exec`/`review` are heavy to start but hold no slot.
- Advice: under memory pressure wait, light commands still run — **never a
  test run**, not even one file, and never a command the classifier lets
  through (`perl t/x.t`): that teaches the way around the guard, and one perl
  took 3.8 GB. Full slots: a smaller run for the retry (it needs a slot too).

## Context line (k6)

`situation()`: context event **and** `under_pressure()` — the first half of
`no_room()`, same limits, same comparison, never a copy — **and** not
`LOADGUARD_THROTTLE=0` → one line (`pressure_figures()`, as in the deny reason,
plus what is refused and what still runs); else not a byte. Full slots alone
add no line, and the path never scans `/proc`. No test run suggested (see
advice). No state across prompts. At most 216 characters
(`test_line_stays_short`). Under Codex without "; see `loadguard status`"
(k14).

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
- A shared `codex app-server` daemon hosts many threads: one scope for all
  (already-confined rule), never skipped.
- Plugin `bin/` is not on Codex's shell PATH; in its sandbox `/proc` is the
  sandbox's PID namespace. Hooks run only after the user trusts them (per
  handler; a changed hooks.json asks again; `codex exec` cannot grant it).

## Learned list (k15)

Exact `tool_input.command` texts, heavy like a pattern (`K_LEARNED`, holds a
slot). `${XDG_STATE_HOME:-~/.local/state}/loadguard/learned.jsonl`, JSON per
line (`command`, `peak_rss`, `cwd`, `first_seen`, `last_seen`), ≤ 100
entries. `LOADGUARD_LEARN=0` → no watcher, list ignored.

- Hook: patterns first, then the list. Read with `O_NONBLOCK` + `fstat`:
  regular file ≤ 1 MiB, ≤ 256 lines, else empty (fail-open, a FIFO must not
  block the light path). Never learn what the fixed list calls heavy.
- Watcher `--watch PID` (PID = the number in the scope name), started
  detached by `hooks/loadguard-confine` after `attached`/`already`; after
  `attached` moved into the scope (`AttachProcessesToUnit`: confine leaves
  the hook chain outside). One per scope (`flock` on
  `$XDG_RUNTIME_DIR/loadguard/<scope>.watch`), 2 s tick, reads
  `cgroup.procs` + `stat` + `statm` only; `cmdline` once per call over the
  limit. Ends when PID is gone or its start time changed — never keeps the
  scope alive, never spins, prints nothing.
- Call = topmost `<shell> -c|-lc` under the session process;
  `shell_command()` serves watcher and slot scan. Claude Code 2.1.283
  wrapper (recorded, `t/fixtures/shells/`): `… && eval '<cmd>'[ < /dev/null]
  && pwd -P >| /tmp/claude-XXXX-cwd`, a quote written `'"'"'`; read the word
  as the shell would, anything else = unknown form, nothing learned. Codex:
  argv[2] (confirmed live 2026-09-27, `shells/codex.json`); bash 5.2 execs
  the last command of `-c`, so a lone Codex command has no shell and is not
  learned — nor holds a slot as a learned one (documented, not rebuilt from
  argv). zsh wrapper unrecorded (no zsh on reuben). The watcher picks the form by the
  session process (claude/codex); an MCP server behind `sh -c` is no call.
- Writes (watcher, `loadguard forget`): `flock` on `learned.lock`, tmp +
  `fsync` + `rename`. Write on crossing `LOADGUARD_LEARN_RSS` (20 % of
  MemTotal, RSS sum of the subtree), at +10 %, and when the shell ends.
- `hooks/hooks.json` stays byte-identical (Codex re-asks trust on change;
  `test_hooks_json_unchanged`).

## CLI (k5)

`bin/loadguard status|doctor|explain` (`lib/loadguard/cli.py`) only formats the
JSON of the binary's read-only report modes: `loadguard-hook --report` (reads no
stdin) and `--explain` (payload on stdin). Both run `objection()`/`no_room()`;
the CLI never classifies, scans or compares a figure — a second decision path
would drift (`test_explain_is_the_hook`). Every other call is hook mode (the
starter passes no arguments): keep it unchanged in behavior and cost. `bin/` is
on the Bash tool's PATH, `CLAUDE_PLUGIN_DATA` is not in its env: the CLI derives
the data dir from its own install path. `learned`/`forget` (k15) manage the
list through `lib/loadguard/learn.py` (data, not a decision; the binary's
report tells which file and state the hook sees).

## Testing

Unit-test the decision function on recorded snapshots: turn files from
`~/load-incidents/` into fixtures (PSI + meminfo + command → expected decision).
The test driver (`-DLOADGUARD_TEST`) runs the real decision against a fixture
root (`decide ROOT`, `slots ROOT`, `measure ROOT`, `report ROOT`, `explain ROOT`,
`heavy`, `extract`, `watch SESSION ROOT...` — one watcher pass per root);
running processes are JSON specs in `t/fixtures/procs/`, context
event payloads (for `decide ROOT`) in `t/fixtures/events/`. Tests set
`XDG_STATE_HOME` so the developer's learned list never leaks in. The production
binary has no root override; low `LOADGUARD_*` limits force its line on the
live host without load.
Never generate real memory pressure on reuben to test — it is the machine this
plugin protects, and it has 8 GB.
