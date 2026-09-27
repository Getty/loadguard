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

## `codex/` — reconstructed, Codex payloads (k11)

Built field by field from the payload structs of codex-rs `rust-v0.153.4`
(= `codex-cli 0.153.4` on reuben), `hooks/src/schema.rs`, in their
serialization order; no recorded counterpart yet (the live test needs
Getty's hook trust). Values: UUIDv7 ids and a rollout path in the shape of
`~/.codex/sessions/…`, the model slug of reuben's config.

| File | Struct | Case |
|---|---|---|
| `pre-tool-use.json` | `PreToolUseCommandInput` (278-296) | the shell tool: `tool_name` `Bash`, `tool_input` `{"command": …}` only (`core/src/tools/handlers/unified_exec/exec_command.rs:504-515`) |
| `pre-tool-use-subagent.json` | same | a spawned subagent thread: `agent_id` (its thread id), `agent_type` `default` (`core/src/hook_runtime.rs:1025-1031`), `transcript_path` `null`, `bypassPermissions` (approval `never`) |
| `user-prompt-submit.json` | `UserPromptSubmitCommandInput` (567-583) | with `turn_id`, the Codex extension |
| `session-start.json` | `SessionStartCommandInput` (499-510) | `source: "startup"`; Codex fires it at the first turn (`core/src/session/turn.rs:264`) |

The hook reads the same fields as in Claude Code's (`hook_event_name`,
`tool_name`, `tool_input.command`, `session_id` for confine); the tests
swap the command.

## `updated-input/` — recorded, pins `updatedInput` semantics

Same session. Per probe: `.pre.json` (PreToolUse payload), `.hook-out.json` (what
the recorder printed), `.post.json` (PostToolUse payload, same `tool_use_id`).
The model sent `description` and `timeout`; `updatedInput` carried only `command`.

| Probe | Hook output | Result |
|---|---|---|
| `probe-a` | `updatedInput` `echo LOADGUARD_PROBE_A` → `…_B`, **no** `permissionDecision` | `…_B` ran; PostToolUse `tool_input` = `{"command": "echo LOADGUARD_PROBE_B"}` |
| `probe-c` | `updatedInput` `…_C` → `…_D`, `permissionDecision: allow` | `…_D` ran; `tool_input` = `{"command": "echo LOADGUARD_PROBE_D"}` |

Asserted by `t/test_updated_input.py`.

## `shells/` — recorded, the shell behind a Bash call (k15, Codex k16)

`claude-code.json`: ten Bash tool calls of a Claude Code 2.1.283 session on
reuben, 2026-09-27, each ending in a script that copied its parent's
`/proc/<pid>/cmdline` — the wrapper shell Claude Code runs the call in
(read-only, no load; the calls were `sleep`, `echo`, `printf`, `cat`).
`command` is `tool_input.command` as sent, `argv` the wrapper's argv,
verbatim (snapshot path and scratch paths of that session included).

argv[0..1] `/bin/bash`, `-c`; argv[2]:

    source <snapshot> 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '<command>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd

- A `'` inside the command is written `'"'"'` (not `'\''`).
- ` < /dev/null` is left out when the command has a heredoc (`heredoc`) or a
  stdin redirection of its own (`stdin-reader`).
- Cases: `plain`, `single` (quotes), `double` (`\"`, `\$`), `heredoc`,
  `cd-backslash-utf8`, `background` (`run_in_background: true`, same form),
  `ansi-comment-leading-space` (`$'…'`, `!`, a comment, a newline, leading
  and trailing blanks), `stdin-reader`, `continuation-subst` (`\<newline>`,
  `$(…)`), `sleep-then`.

`codex.json`: one `exec_command` call of a Codex session (codex-cli
0.153.4, loadguard 0.2.0 installed) on reuben, 2026-09-27 — Getty's live
test. `command` is the model's `cmd` as the session's rollout holds it
(Codex passes it to PreToolUse as `tool_input.command`), `argv` the argv of
the shell running it, read from `/proc` while its `sleep 45` ran (no load).
argv is `/bin/bash`, `-c`, the command unchanged: the shell snapshot's
script `exec`s `/bin/bash -c '<command>'` (the rollout records the call as
`/bin/bash -lc <command>`, the form Codex wraps in that script). Case `list`
(`sleep 45; echo "lg probe" 'x'`: quotes, a `;` list, so bash stays with
`sleep` as its child).

`t/test_learn.py` requires the extraction to give back `command` byte for
byte — Claude Code's form from `claude-code.json`, Codex's from
`codex.json` — and builds its scenario wrappers the same way
(`claude_wrapper()`, checked against these). The Codex chain's shell,
`procs/codex-session.json` pid 7203, has the recorded form.

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
| `codex-exec.json` | A started `codex exec`, idle, in A's scope (k11) | 0 |
| `codex-session.json` | a Codex TUI session in its own scope runs `prove -lr t/; echo "exit $?"` through its Linux sandbox (k11, below) | 1 |

PIDs are disjoint across specs, so tests combine them (all eight: 5 slots).

### The Codex chain (`codex-session.json`)

Reconstructed from the codex-rs `rust-v0.153.4` sources for reuben's setup
(`sandbox_mode = "workspace-write"`, no system `bwrap`, so the bundled
`codex-resources/bwrap`), then seen so in Getty's live test on 2026-09-27
(codex-cli 0.153.4, the `codex.json` call, read-only): the same processes
from `codex` down to the command, their argv beginning as below, bwrap's
comm `3`. Beside the chain that session had `codex-code-mode-host` and an
MCP server run as `python3 -I -c …`; the spec keeps an npm one there.

| PID | comm | argv | Source |
|---|---|---|---|
| 7100 | `codex` | `codex` — the TUI, hosting the thread in-process | `tui/src/lib.rs:255-282` |
| 7200 | `codex-linux-san` | `~/.codex/tmp/arg0/codex-arg0XXXXXX/codex-linux-sandbox --sandbox-policy-cwd … --command-cwd … --permission-profile <json> -- /bin/bash -c <script>` | `sandboxing/src/manager.rs:414-443, 731-737`, `sandboxing/src/landlock.rs:23-58`, `arg0/src/lib.rs:355-425` (a symlink to codex; comm is cut to 15 bytes) |
| 7201 | `3` | `bwrap --as-pid-1 --new-session --die-with-parent <mounts> --unshare-user --unshare-pid --unshare-ipc --unshare-net --proc /proc --chdir … --cap-drop ALL --argv0 codex-linux-sandbox -- <codex> … --apply-seccomp-then-exec -- /bin/bash -c <script>` | `linux-sandbox/src/linux_run_main.rs:393-469, 475-506, 555-615`, `bwrap.rs:308-357`, `launcher.rs:38-57`; the bundled bwrap is exec'd through `/proc/self/fd/N` (`bundled_bwrap.rs:36-72`), so comm is that number (`3` live) |
| 7202 | `codex` | `codex-linux-sandbox … --apply-seccomp-then-exec -- /bin/bash -c <script>` — PID 1 of the new namespaces, forks the command and waits | `linux_run_main.rs:192-259, 1511-1550` |
| 7203 | `bash` | `/bin/bash -c 'prove -lr t/; echo "exit $?"'` | `core/src/shell.rs:22-31`; with the shell snapshot (default) Codex runs `bash -c ". <snapshot>; exec '/bin/bash' -c '<cmd>'"`, the exec leaves this argv (`core/src/tools/runtimes/mod.rs:225-302`; live: `shells/codex.json`). bash stays for a `;` list; a lone command it would `exec` (bash 5.2), leaving prove directly under 7202 (`test_codex_lone_command_leaves_no_shell`) |
| 7204, 7205 | `prove`, `perl` | as in `prove-chain.json` | |

Simplified: the mounts, and the permission profile JSON (no entries);
`<script>` without the PATH exports Codex puts around the `exec`. Without
paths to protect that do not exist yet, the outer helper execs bwrap
instead of forking it: 7200 and 7201 are then one process. None of this is
read by the classifier, which judges argv[0] (and an interpreter's script)
only. `/bin/bash -lc` — before the snapshot exists — is covered by
`test_codex_login_shell`.
