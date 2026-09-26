# Hook payload fixtures

**Recorded** payloads are verbatim stdin of the hook, captured 2026-09-26 (k7) in
one isolated session with Claude Code 2.1.283:
`claude -p … --plugin-dir ~/dev/loadguard --model haiku` with a temporary
recorder in `hooks/loadguard` (reverted), cwd in a scratch directory. `session_id`,
`transcript_path` and `cwd` point at that throwaway session (no transcript was
kept). The payloads carry no prompt content.

Recorded `tool_input` holds **only the keys the model passed** — no defaulted
`description`, `timeout` or `run_in_background: false`.

**Reconstructed** payloads follow the PreToolUse schema at
https://code.claude.com/docs/en/hooks as read on 2026-09-26; they have no recorded
counterpart yet. Their `tool_input` shows keys a real payload may lack.

| File | Origin | Case |
|---|---|---|
| `bash-plain.json` | **recorded** | light Bash command (`pwd`) |
| `bash-heredoc.json` | **recorded** | quoted heredoc with `'single'`, `"double"`, literal `$HOME` |
| `bash-background.json` | **recorded** | `run_in_background: true` |
| `bash-subagent.json` | reconstructed | fired inside a subagent (`agent_id`, `agent_type`) |
| `bash-no-command.json` | reconstructed | Bash payload without `tool_input.command` |
| `read-tool.json` | reconstructed | non-Bash tool |
| `broken.json` | synthetic | truncated JSON |
| `empty.json` | synthetic | empty stdin |
| `not-an-object.json` | synthetic | valid JSON, not an object |
| `invalid-utf8.json` | synthetic | bytes that are not UTF-8 |

## `events/` — reconstructed, the context events (k6)

UserPromptSubmit and SessionStart payloads for the context line, copied from the
examples at https://code.claude.com/docs/en/hooks as read on 2026-09-26 (the
SessionStart one with `source: "startup"` instead of the documented resume).
No recorded counterpart yet. The hook reads only `hook_event_name` of them; the
tests replace fields to build broken and foreign variants.

| File | Event |
|---|---|
| `user-prompt-submit.json` | `UserPromptSubmit`, with `prompt` |
| `session-start.json` | `SessionStart`, `source: "startup"`, `model` |

## `updated-input/` — recorded, pins `updatedInput` semantics

Same session. Per probe: `.pre.json` (PreToolUse payload), `.hook-out.json` (what
the recorder printed), `.post.json` (PostToolUse payload, same `tool_use_id`).
The model sent `description` and `timeout`; `updatedInput` carried only `command`.

| Probe | Hook output | Result |
|---|---|---|
| `probe-a` | `updatedInput` `echo LOADGUARD_PROBE_A` → `…_B`, **no** `permissionDecision` | `…_B` ran; PostToolUse `tool_input` = `{"command": "echo LOADGUARD_PROBE_B"}` |
| `probe-c` | `updatedInput` `…_C` → `…_D`, `permissionDecision: allow` | `…_D` ran; `tool_input` = `{"command": "echo LOADGUARD_PROBE_D"}` |

Asserted by `t/test_updated_input.py`.

# Measurement fixtures

## `incidents/` — excerpts of `~/load-incidents/*.txt`

Verbatim copies of **only** the measurement sections (`loadavg`, `Speicher` =
`free -m`, `I/O-Druck (PSI)`) of three snapshots from `~/bin/load-watchdog.sh`.
Process sections (D-state, Top 25, counts, karr/git/ssh) are left out: they
carry command lines, env and prompts. The watchdog fires only at load1 >= 20,
so there is no truly calm snapshot; "calm" means calm memory.

The PSI section is unlabeled: the watchdog runs
`cat /proc/pressure/io /proc/pressure/cpu /proc/pressure/memory` — order io,
cpu, memory, known from the script, not from the file. No zram data is
recorded; `Swap:` is the sum of all swap devices (on reuben, per `/proc/swaps` and `/etc/fstab` today:
3.2 GB zram + 8 GB `/swapfile`).

| File | Role | Why |
|---|---|---|
| `20260925-225204.txt` | calm memory, CPU-bound | load 20, cpu some 95 %, memory/io PSI ~0, swap 53 % used, 1.9 GB available |
| `20260926-011126.txt` | tipping | memory some avg10 10.4 rising over avg60 6.1 / avg300 3.7, full 0.74, lowest MemAvailable (1279 MB) of the CPU-bound regime, swap 64 % |
| `20260917-175030.txt` | thrash | the 3.8 GB `perl` one-liner: swap 100 %, memory full 60 %, io full 79 %, load5 only 5.9 (sudden) |

## `proc/` — `/proc`-like trees for `read_snapshot(root=…)`

| Tree | Origin |
|---|---|
| `reuben-recorded-20260926/` | **Recorded** verbatim from reuben on 2026-09-26 01:48 (`proc/loadavg`, `proc/meminfo`, `proc/pressure/*`, `sys/block/zram0/{disksize,mm_stat}`), memory calm, cpu some ~86 % |
| `thrash-20260917-175030-reconstructed/` | **Reconstructed** from `incidents/20260917-175030.txt`: loadavg and PSI lines copied, `meminfo` holds only the four keys, rebuilt from `free -m` (MiB × 1024 kB). No zram (not in the snapshot). |

## `procs/` — running processes, as JSON specs

**Reconstructed by hand** (k4) for the slot scan; `t/test_throttle.py` turns each
spec into `/proc/<pid>/{stat,cmdline,cgroup,cwd}` on top of a `proc/` tree. JSON,
not raw `/proc` files, so a diff shows the argv. Shapes follow what reuben showed
live on 2026-09-26 (read-only): Claude Code's wrapper
`/bin/bash -c 'source <snapshot> … && eval '<cmd>' && pwd -P >| /tmp/claude-XXXX-cwd'`,
`claude` in `app-loadguard.slice/loadguard-<session8>-<pid>.scope`, MCP servers as
`npm exec …` whose cmdline is a process title padded with NULs (npm sets
`process.title` to `npm` + its positional args, `lib/npm.js`), `comm` with spaces.
prove runs as `/usr/bin/perl /usr/bin/prove …` (`#!/usr/bin/perl`), its test
children as `/usr/bin/perl t/….t` (TAP::Harness passes `-l` via `PERL5LIB`); the
MakeMaker `make test` chain follows its generated Makefile. No heavy command was run
to record these.

| Spec | Scenario | Heavy slots |
|---|---|---|
| `idle-sessions.json` | sessions A (pid 4100) and B (5100) with MCP servers, a `git status` and a plain `make`; outside the slice a tmux `prove` and a terminal `make test`; a kernel thread | 0 |
| `prove-chain.json` | A runs `prove -lr t/`: wrapper, prove, two perl test children | 1 |
| `make-recursion.json` | B runs `make test`, recursing into `xs/` (`sh -c` → `make test`) plus the harness | 1 |
| `claude-p.json` | A started a nested `claude -p` and a `claude --bg`, both idle, same scope | 0 |
| `claude-p-prove.json` | the `claude -p` above runs `prove -l t/foo.t` (needs `claude-p`) | 1 |
| `npm-title.json` | B runs `npm test` (title `npm test`), which runs `sh -c 'prove -lr t'` | 1 |

PIDs are disjoint across specs, so tests combine them (all six: 4 slots).
