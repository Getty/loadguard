# loadguard — Design

Claude Code plugin (Getty marketplace) that **measures and limits the load AI
processes put on the host, and reports it back to the AI**, so it can steer against
it itself. Target host first: `reuben` (4 cores, ~8 GB RAM; swap = 3.2 GB zram0 + 8 GB `/swapfile`).

## The problem, with evidence

`~/load-incidents/*.txt` (54 snapshots from `~/bin/load-watchdog.sh`, triggered at
loadavg ≥ 20). The pattern before the power-button reboots:

- RAM full, **swap (zram + swapfile) 100 % full**, memory/IO PSI `full` > 50 %, load up to 85.
- 5–7 parallel `claude` sessions, each in D state (`folio_wait_bit_common`).
- **A single command eats everything**: `20260917-175030.txt` shows a
  `perl -Ilib -MJSON::Schema::Modern -e …` with **3.8 GB RSS (48 % RAM)** — a
  harmless-looking one-liner, no `prove`, no `make`.
- Headless agents in podman (`perlbench`) run `prove -lr t/` in an endless loop.

The central lesson from the 3.8 GB one-liner: **pattern matching on "heavy commands"
alone is not enough.** The protection has to apply to *every* AI Bash command; the
pattern only decides how strict it is.

## Mechanism

A `PreToolUse` hook with matcher `Bash`. It receives the command as JSON on stdin
and may (a) let it through, (b) rewrite it (`updatedInput`) or (c) refuse it
(`permissionDecision: deny` + reason — that reason reaches the AI and is the
channel through which it steers against the load).

**`updatedInput` replaces `tool_input` completely** (pinned down 2026-09-26, k7,
Claude Code 2.1.283, `t/fixtures/updated-input/`): fields the hook leaves out
(`description`, `timeout`) are then missing from the executed `tool_input`. So the hook
has to copy the incoming `tool_input` completely and swap only `command`. The
incoming `tool_input` contains only what the AI set — no defaults.
`updatedInput` works without `permissionDecision`; loadguard sends no `allow` when it
rewrites.

**Permissions are checked against the rewritten command** (k3, live, corrects the
k7 conclusion): with only the original in `--allowedTools` the wrapped command was
refused, with only the wrapped strings everything ran. k7 saw the opposite only
because its rewrite was `echo …`, which Claude Code allows as read-only anyway.
So a rewrite breaks the user's permissions — stage 1 via `updatedInput` is not
viable in this form (options: card k3).

### Stage 1 — Confine: the whole session (decided 2026-09-26)

The original plan was to wrap every command via `updatedInput` in
`systemd-run --user --scope … -- bash -c '<original>'`. k3 showed live that this is
not viable: permissions are checked against the rewritten command (every
`Bash(git:*)` rule breaks), and Claude Code runs every call as
`bash -c 'source <snapshot> && eval <cmd> && pwd -P >| <cwd-file>'` — a child shell
inside the scope loses `cd` and the snapshot functions.

Instead: **the SessionStart hook moves the `claude` process itself into a transient
systemd user scope with limits** (D-Bus `StartTransientUnit` with `PIDs=` only for
`claude`; whatever `claude` started before follows via `AttachProcessesToUnit`, for
which `Delegate=yes` — k12: a vanished PID in `PIDs=` makes the unit fail
asynchronously although the call succeeds).
Everything the session starts — Bash commands, subagents, MCP servers — inherits the
scope. Commands are never rewritten: permissions, `cd`, functions, exit codes and
`run_in_background` stay untouched; stage 1 costs nothing per Bash call.

Verified on reuben: the memory controller is delegated to `user@1000.service`
(`cpu memory pids`, not `io`), `memory.max` takes effect (OOM in the scope → rc 137), a
foreign PID can be moved from the logind `session-N.scope` into a scope of its own
(asynchronously, ~1–21 ms).

Trade-offs, accepted deliberately:
- The limit applies per session, not per command; `claude` itself (~300 MB) counts too.
- At `MemoryMax` the kernel picks the largest process in the scope — usually the
  outlier, not `claude`.
- `claude` leaves the logind session scope.
- Only stage 2/3 limit globally across all sessions.

Fallback without systemd/delegation (macOS, containers): stage 1 off, fail-open.
Likewise without linger (`/var/lib/systemd/linger/$USER`): otherwise a `claude` in
`screen`/`tmux` would die with the user manager at the last logout. Off switch:
`LOADGUARD_CONFINE=0`. Nested `claude -p` deliberately stay in the scope of the
parent session and share its limit (decided 2026-09-26).

Implemented (k3, `hooks/loadguard-confine`, `lib/loadguard/confine.py`):

- **A separate async SessionStart hook**, Python. Once per session a subprocess is
  cheap: `busctl --user call … StartTransientUnit` (ships with systemd; no
  re-implemented D-Bus protocol). Live: call 10 ms, move confirmed after ~30 ms
  (`/proc/<pid>/cgroup`, polled for at most 1 s). Async is enough: processes
  claude started before the attach (MCP servers, an early command) are moved along as
  descendants; in both live sessions the hook was done before the first
  Bash.
- **Which process:** the hook's nearest ancestor with `comm` or `argv[0]`
  `claude` (at most 8 levels; since k11 also `codex`), read from `/proc`.
- **One rule for idempotence and nesting:** if this claude already sits in
  any `loadguard-*.scope`, nothing happens. resume/clear/compact are no-ops that
  way, and a `claude -p` from a confined session stays in the parent's scope —
  taking it out would mean escaping the limit.
- **Name `loadguard-<session_id[:8]>-<pid>.scope`** in **`app-loadguard.slice`**:
  `app.slice` is the place for applications in the user manager; the slice of its own
  gives stage 2/3 a node for a shared limit across all sessions. The PID makes
  the name unique, even when two processes resume the same session.
- **`OOMPolicy=continue` is mandatory:** the default is `stop` — an OOM kill of the
  outlier would end the whole scope and with it claude. `CollectMode=
  inactive-or-failed`: the scope disappears with its last process.
- **Limits** in % of MemTotal, via env: `LOADGUARD_MEMORY_HIGH` 30,
  `LOADGUARD_MEMORY_MAX` 40, `LOADGUARD_MEMORY_SWAP_MAX` 10, `LOADGUARD_CPU_WEIGHT`
  50 (systemd default 100). On reuben: high 2.3 GiB, max 3.1 GiB, swap 0.8 GiB.
  The 3.8 GB Perl one-liner (20260917-175030) does not fit in together with claude
  (max + swap < 3.8 GB + 0.3 GB) and is OOM-killed inside the scope; from 2.3 GiB on
  the session is throttled, a normal build stays below that. `IOWeight` is missing: `io`
  is not delegated.
- **Delegation** once per boot: `memory` in `user@UID.service/cgroup.controllers`,
  cached as `<boot_id> yes|no` in `$XDG_RUNTIME_DIR/loadguard/delegation`.
- **Known:** cgroup v2 does not move memory charges along on a move — what claude
  allocated before the attach stays charged to the logind scope. Without linger
  `user@UID.service` ends with the last login session and takes the scopes with it
  (reuben: `Linger=yes`).

### Stage 2 — Limit globally (heavy commands)

Across **all** of the user's Claude sessions at most N heavy commands run
at the same time (default: `max(1, nproc/2)`). **Counted by a `/proc` scan** (decided
2026-09-26): the PreToolUse hook counts running heavy processes under
`app-loadguard.slice`. `flock` slots don't work, because the hook ends before the command
starts, and commands are not rewritten (k3). No locks, nothing can get
stuck; accepted race: two sessions starting at the same moment both see
a free slot. Heavy = pattern (`prove`, `dzil test|build|release`,
`make test`, `cpanm`, `docker|podman build|run`, `cargo build|test`, `npm test`,
`perlbench`, `claude --bg`, `claude -p`, since k11 `codex exec`, since k14
`codex review`) **plus** everything
that later pulled a lot of memory inside the scope (learned list, below).

No free slot → stage 3 instead of silent waiting (the AI should know it is waiting).

### Memory signal (decided 2026-09-26)

From the 54 snapshots (k2): **memory PSI `full avg10`** separates sharply — < 2 % in the
CPU-heavy phase, > 45 % in every thrash snapshot, nothing in between. `avg10`, not
`avg60/300`: the thrash arrives abruptly (175030: avg10 63 %, avg300 20 %).
Secondary signal: **total swap** (`SwapFree/SwapTotal` from `/proc/meminfo`) — 100 % used
in every thrash snapshot, never in the quiet phase. **zram fill level alone is no
signal**: zram0 already sits at ~98 % at rest, the swapfile takes the overflow;
it only appears as information in the reason. `MemAvailable` is weak (1.1–1.7 GB
even during thrash). `cpu some` is routinely high on reuben and no emergency.

### Stage 3 — Refuse with a reason

Under pressure above the threshold (memory signal above) or without a free slot, a
heavy command is refused. The reason is the product — short, measurable, with a
concrete alternative:

> loadguard: memory pressure full=38% (limit 20%), swap 97%, 2/2 heavy slots busy
> (prove -lr t/ in ~/dev/sunriser, perlbench). Wait, or test selectively
> (`prove -l t/foo.t` instead of `-r`). Don't start new `claude --bg`.

Light commands (`git status`, `karr show`, `ls`, `cat` …) are never refused —
otherwise the AI could not even look at what is going on.

### Implemented (k4): stage 2 + 3

`src/loadguard-hook.c`, tests `t/test_throttle.py`.

- **One rule, in the C binary:** incoming command heavy **and** (memory pressure
  **or** all slots taken) → deny JSON on stdout, exit 0. Otherwise no output,
  exit 0, as before. A light command triggers not a single read
  (stdin only); test: `/proc/pressure/memory` as a FIFO does not block it.
- **Thresholds**, via env, integers, `%` allowed, invalid or outside
  1–100 (slots 1–4096) → default:
  `LOADGUARD_PSI_FULL` **10** (memory `full avg10` in %),
  `LOADGUARD_SWAP_USED` **90** (total swap used in %),
  `LOADGUARD_HEAVY_SLOTS` **`max(1, nproc/2)`** (CPUs of the affinity, like `nproc`;
  reuben: 2). `LOADGUARD_THROTTLE=0` — exactly `0` only — switches to pure
  pass-through.
- **Derivation** from the 54 snapshots (parser k2; test `Calibration` rebuilds each as a
  `/proc` tree and checks the binary's decision):
  quiet 18× — full avg10 0.00–2.03 %, swap 50.6–68.3 %;
  thrash 36× — full avg10 45.47–84.51 %, swap 91.9–100 %. Exceptions on swap:
  20260816-204258 (no swap at the time) and 20260917-183232 (right after a
  kill: 20 % used, 5 GB free, PSI still 62.9).
  PSI 10 lies near the geometric mean of the gap (√(2.03 · 45.47) ≈ 9.6):
  five times above the quiet maximum, 4.5 times below the smallest thrash. Swap 90
  lies between 68.3 and 91.9. Combined with **OR**: PSI alone already refuses
  every thrash snapshot, swap alone 34 of 36; no quiet snapshot reaches either
  threshold. Swap ≥ 90 % with low PSI means: nothing left to swap out, the
  next large command evicts file pages — the road into thrash before PSI shows
  it. zram appears only in the reason. Live reuben (2026-09-26): full
  0.01 %, swap 51 %, zram 98 %, 297 processes → nothing refused.
- **No process scan under pressure.** `/proc/<pid>/cmdline` reads the
  argument pages of the foreign process — swapped out during thrash, the reader waits for
  swap IO. A hook timeout does **not** block the command according to the docs: a slow
  scan would let exactly the heavy command through. The pressure reason therefore names only the
  measurements, no slot holders. Test: a cmdline as a FIFO would block every reader,
  the pressure decision still comes immediately.
- **Slot scan** (only without pressure): one pass over `/proc`; `cgroup` contains
  `/app-loadguard.slice/` → `stat` (ppid after the last `)` — comm can contain
  spaces and parentheses, npm: `npm exec claude`) and `cmdline`.
  argv is judged, not text: basename of argv[0]; for interpreters (`perl`,
  `python3`, `node`, `sh`, `bash` …) the script — the kernel starts prove as
  `/usr/bin/perl /usr/bin/prove -lr t/`. Inline code (`-c`, `-e`, `-E`) is no
  script: the Claude Code wrapper `bash -c '… eval …'` never counts, even if its
  format changes. A process title (npm writes `npm test`, padded with
  NULs) is split at spaces. Only the **topmost** heavy
  process of a chain inside the slice counts: prove with perl children, recursive
  `make test`, `npm test` → prove are one slot each. `claude -p`/`--bg` hold
  no slot; what they start counts individually.
- **Heavy (incoming):** the string is split into simple commands (`;` `&` `|`
  `(` `)` `` ` `` newline), respecting quotes, backslashes,
  comments, redirections and heredoc bodies. Skipped before the command word:
  `VAR=x`, `nice` `ionice` `nohup` `timeout` `env` `stdbuf` `setsid` `xargs`
  `time` `exec` with their options and numbers, `if` `then` `do` `!` `{` … Patterns as
  above, plus `claude --print` (= `-p`). No shell parser: anything unclear falls to
  light (`bash -c 'prove …'`, `sudo prove`, `find -exec prove`, more than 32
  words before `test`) — the session limit from stage 1 still applies.
- **Reason** in English, two lines — numbers, then advice:

  > loadguard: heavy command refused (dzil test): 2/2 heavy slots busy (prove -lr
  > t/ in ~/dev/sunriser; make test in ~/dev/p5-foo), memory pressure full=0.0%
  > (limit 10%), swap 60% used (limit 90%), zram 97% full.
  > Wait for one to finish, then retry; light commands (git status, ls, cat) still
  > run. When you retry, run a single test file instead of the whole suite.

  Under pressure: `…: memory pressure full=59.9% (limit 10%), swap 100% used (limit
  90%).` / `Wait and retry later; light commands (git status, ls, cat) still
  run.` Per-pattern advice only when slots are full, and for the next attempt —
  even a small run is heavy and needs a slot: prove → `When you
  retry, run fewer tests: prove -l t/foo.t instead of -r`; test suite → a single
  test file. `claude -p`/`--bg` → no new sessions, in both cases.
  **No test run as advice under pressure** (corrected in k6, k4 was
  unreleased): every run pulls memory, a single perl can take the
  machine (the 3.8 GB one-liner, 20260917-175030), and `prove -l
  t/foo.t` would be refused under pressure just the same. Naming a command the
  classifier lets through (`perl -Ilib t/foo.t`) would mean showing the AI the way
  around its own guard. So: wait, light commands work.
  At most three holders, then `+N more`; paths with `~`, control characters and
  invalid UTF-8 as `?`.
- **Cost** (reuben, 297 processes, 300 runs each including process start, `nice`):
  light 0.53 ms median (`/bin/true`: 0.50), heavy and quiet with a full scan
  3.64 ms (p90 4.44), heavy under pressure 0.62 ms. Target < 30 ms.
- **Fail-open:** no PSI file, no swap, unreadable `/proc` → that signal
  reports no pressure; a process that disappears between `readdir` and the read
  does not count. Never exit 2, SIGPIPE ignored. Output without a
  trailing newline — the form k7 tested live.
- **Testability:** the root for `/proc` and `/sys` exists only in the test driver
  (`-DLOADGUARD_TEST`: `decide ROOT`, `slots ROOT`, `measure ROOT`, `heavy`); the
  production binary always reads the real `/proc`. Running processes come as
  JSON specs from `t/fixtures/procs/`. **For k5:** a synthetic payload on the
  production binary's stdin yields the live decision — deny JSON or
  nothing; *why* something passes, the binary does not say (k5: there is
  now `--explain` for that).
- **Races, accepted:** two sessions at the same moment both see a free
  slot; likewise a command whose heavy process is not running yet.
- **Confirmed live** (2026-09-27, `claude -p --plugin-dir` with Haiku, Claude
  Code 2.1.283): quiet with default thresholds all five hooks stay silent,
  `make test` runs. With `LOADGUARD_HEAVY_SLOTS=1` and a `make test` from
  another session in the slice the hook refuses with the slot reason and names
  the foreign holder; no context line (full slots alone don't count).

### Learned list (decided 2026-09-27)

Purpose: preventive, for heavy commands outside the fixed list (own
scripts, build and test tools not listed there). **[corrected
2026-09-27]** The evidence cited here was `/usr/bin/perl t/json_data.t` (3.2–3.4 GB on
three days, 20260912/-17/-21) as a test file run "directly with `perl`". Wrong: in
all three snapshots its parent process is MakeMaker's `test_harness`, it ran
under `make test`, which the fixed list already catches (finding k15). None of the 54
snapshots shows a case only the learned list would have caught; the
3.8 GB one-liner occurred only once, and only the scope limit helps against it
(stage 1).

- **Unit = the exact command text** (Getty 2026-09-27: no abstraction,
  "most of it will be prove or something with a container"): the string
  the model sends as `tool_input.command`, byte for byte. `cd x && …`
  and `…` are two commands. What the fixed list already calls heavy is
  not learned.
- **Learned when** a command's processes together (RSS sum of the
  subtree below its shell) reach `LOADGUARD_LEARN_RSS` % of `MemTotal`,
  default **20** (reuben 1.6 GB), 1–100. RSS, not PSS:
  `smaps_rollup` walks the page tables and can hang under thrash.
- **One watcher per session** (Getty 2026-09-27: A): the hook binary in
  `--watch` mode, started detached by `hooks/loadguard-confine` after confinement
  (setsid, stdio to `/dev/null`, `nice`), lives in the session's scope.
  Every 2 s: the scope's `cgroup.procs`, per PID `/proc/<pid>/stat` and `statm` —
  both without swapping in foreign pages; `cmdline` only once per new
  shell that crosses the threshold. One watcher per scope (`flock` on a
  file in `$XDG_RUNTIME_DIR/loadguard/`); a resumed or
  nested start in the same scope ends immediately. It ends as soon as the
  session process is gone — it must never keep the scope alive. Without a
  binary (first session, build running) there is no watcher in that session.
  Rejected: a shared service (singleton over D-Bus, more moving
  parts); only watching during hook runs (a foreground command calls no
  hook while it runs).
- **Which command:** from the large subtree upward, the topmost
  `<shell> -c|-lc <string>` below the session process. Claude Code:
  `/bin/bash -c '… eval '<cmd>' … && pwd -P >| /tmp/claude-XXXX-cwd'` — the
  `eval` text, with single quotes unescaped (recorded: `'"'"'`, not
  `'\''` — k15 below), is `tool_input.command`
  (seen live 2026-09-26 for a simple command; quotes, newlines,
  heredocs, `run_in_background`: recorded in k15). Codex: `bash -c|-lc
  <cmd>` behind the sandbox chain, argv[2] = the command (confirmed live
  2026-09-27, `t/fixtures/shells/codex.json`). Unreadable or unknown
  form → nothing learned.
- **Write immediately:** at the first crossing of the threshold, not only at the end —
  a thrash reboot in the middle of the command must not lose the lesson. After that
  the watcher rewrites the peak only when it has grown by at least 10 %,
  and once when the shell ends.
- **Storage:** `${XDG_STATE_HOME:-~/.local/state}/loadguard/learned.jsonl`, one
  per user, shared by Claude Code and Codex. One JSON object per line:
  command, peak RSS, cwd, first and last seen large. At most 100
  entries; beyond that the one not seen large for the longest drops out. Writes are
  atomic (tmp + rename) under `flock` — watcher and CLI.
- **In the hook:** exact match → heavy, like a pattern match (refused under
  pressure or with full slots); the reason says it is learned, with
  peak and date. A running learned command holds a slot: the
  scan recognizes its shell via the same extraction (topmost holder counts,
  as before). **Invariant changed** (Getty 2026-09-27): the light path
  now reads one file, the learned list — without a file, one failed
  `open`. Broken, too large, unreadable → empty (fail-open).
- **Switches:** `LOADGUARD_LEARN=0` (exactly `0` only): no watcher, list
  ignored. `LOADGUARD_THROTTLE=0` switches off all refusing, as before.
- **CLI:** `loadguard learned` (list with number, peak, last, cwd, command),
  `loadguard forget <n>` / `--all`; `explain` names a learned match;
  `doctor` shows learning on/off, entries, this session's watcher.
- **`hooks/hooks.json` stays unchanged** — otherwise Codex demands new trust.
- **Limits:** the first run is never caught (that is what the scope limit is for);
  whatever explodes in under 2 s and is killed in the scope can escape the watcher;
  a session without a scope (no linger, `LOADGUARD_CONFINE=0`) does not learn.
  Under Codex a single command is not learned (bash `exec`s it,
  no shell carries the text; below, k15/k14). A command learned under Claude Code
  that later runs under Codex as a single command is refused on
  entry (the hook compares `tool_input.command`), but holds
  no slot while it runs: the slot scan finds learned commands only
  via the shell that carries their text, and does not compare argv with the
  list. Deliberately not reconstructed (Getty 2026-09-27: the exact text,
  no argv rebuild).

### Implemented (k15): learned list

`src/loadguard-hook.c` (`--watch`, list in the hook and in the slot scan),
`lib/loadguard/learn.py`, `hooks/loadguard-confine`, `lib/loadguard/cli.py`;
tests `t/test_learn.py`, plus `t/test_cli.py` `Doctor`,
`t/test_hook_passthrough.py` `CodexRuns`/`PluginWiring`; fixtures
`t/fixtures/shells/claude-code.json`.

- **Wrapper recorded** (2026-09-27, Claude Code 2.1.283, ten own
  Bash calls; a child read `/proc/<wrapper>/cmdline`, read-only, no
  load): `/bin/bash -c 'source <snapshot> 2>/dev/null || true && shopt -u
  extglob 2>/dev/null || true && { \builtin unalias … } >/dev/null 2>&1 ||
  true && eval '<cmd>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd'`. A
  `'` in the command appears as **`'"'"'`** (close quote, `"'"`, open quote), not
  as `'\''` as assumed above. ` < /dev/null` is missing when the command
  has a heredoc or its own stdin redirection. Single and double
  quotes, heredoc, newline, line continuation, `$(…)`, backslashes,
  UTF-8, `cd x &&`, leading and trailing spaces,
  `run_in_background` (same form): in all ten cases the
  extraction reads back the sent command byte for byte.
- **One extraction** (`shell_command()`) for watcher and slot scan:
  `<shell> -c|-lc <string>`, shell bash, sh, dash or zsh. Claude Code:
  the word after the first `eval `, read the way the shell reads it (`'…'`
  literal, `"…"` with `\"` `\\` `\$` `` \` `` `\<NL>`, `\x`), then exactly
  `[ < /dev/null] && pwd -P >| <path>-cwd` to the end. `$` or backtick
  in `"…"`, any other unquoted character, a different ending → unknown
  form. Both quote spellings read the same. Codex: argv[2]
  unchanged. The watcher takes the form of the session process (claude →
  only the wrapper, codex → only argv[2]) — so under Claude Code an
  MCP server behind `sh -c 'context7-mcp'` (as on reuben) is never learned; the
  slot scan does not know the harness and takes the wrapper, otherwise argv[2].
- **Watcher** `loadguard-hook --watch PID`, PID = the process the
  scope was created for (the number in the scope name): a nested
  `claude -p` or another app-server thread asks for the watcher
  that is already running. At start: `comm`/argv[0] `claude` or `codex`,
  `/proc/PID/cgroup` ends in `loadguard-*.scope`, MemTotal readable,
  `$XDG_RUNTIME_DIR` set and `<scope>.watch` in it free via `flock` LOCK_NB
  (the file holds its PID, for `doctor`) — otherwise exit 0 immediately.
  `setpriority` 10, `chdir /`, no output. Every 2 s: start time of the
  session process unchanged (otherwise end, also on a reused
  PID), `cgroup.procs`, per PID `stat` (ppid, comm, start time) and `statm`.
  Invocation = topmost shell (by `comm`) below the session process, its
  RSS = sum over the shell and all descendants; orphans (parent not in the scope,
  `foo &` after the shell ended) count for nobody. `cmdline` exactly once, when
  an invocation crosses the threshold; after that learned or remembered as
  skipped until its shell ends (at most 16 at a time). Not learned:
  unknown form, fixed list, empty, over 4096 bytes, not UTF-8.
  Written at the crossing, at ≥ 10 % more, at the end of the shell, and
  for all open ones when the session process is gone. The lock file goes
  with it.
- **List**: per line `{"command", "peak_rss" (bytes, the highest ever
  seen), "cwd", "first_seen", "last_seen" (UTC, ISO 8601)}`. Watcher
  and `loadguard forget` write under `flock` on `learned.lock`: new
  file, `fsync`, `rename`, `fsync` of the directory; mode 0600, the
  directory 0700. Beyond 100 entries the one with the smallest
  `last_seen` drops out; broken lines drop out on write, a file that is too large
  is replaced.
- **In the hook**: first the patterns, then the list (`K_LEARNED`, holds a
  slot). Read via `open(O_NONBLOCK)` and `fstat`: only a regular file
  up to 1 MiB, at most 256 lines — a FIFO in its place does not block the
  light path. Reason: `loadguard: heavy command refused (learned:
  peaked at 3.4 GiB RSS on 2026-09-21): memory pressure …` (date from
  `last_seen`, only `YYYY-MM-DD` taken); advice as for any heavy
  command, without an addition of its own. Slot scan: a shell whose command is in the
  list is a holder, named after the command (truncated to 48 bytes);
  it reads cmdlines up to 64 KiB, truncated → no match; empty list →
  no extraction.
- **Start**: `hooks/loadguard-confine` after `confine()`, only on `attached`
  or `already`, binary from `$CLAUDE_PLUGIN_DATA/bin` (Codex sets it
  too), detached like the build (fork, setsid, stdio to `/dev/null`,
  cwd `/`, not waited for). After `attached` the hook runs outside the
  scope — `confine()` moves the session, not the hook chain —, so
  the watcher gets in via `AttachProcessesToUnit`; after `already`
  the hook is already inside. `hooks.json` unchanged byte for byte (a test
  pins the SHA-256).
- **Report and CLI**: `--report` has `learn` (`on`, `file`, `state`,
  `entries`, `rss_limit`); `ignored` names `LOADGUARD_LEARN` ≠ `0` and an
  invalid `LOADGUARD_LEARN_RSS`. `loadguard learned` (number, peak,
  last, cwd, command; ASCII only), `loadguard forget <n>…|--all`; `explain`
  names the match in the heavy label (`yes (learned: …)`); `doctor` has the
  section "learning": list, threshold in GiB, this session's watcher
  (PID from `<scope>.watch`, whose argv is `… --watch …`). If it is missing in a
  confined session, that is a FAIL.
- **Cost** (reuben, 318 processes, 1500 runs each alternating against HEAD,
  `nice`, process start included): light HEAD 0.579 ms → without a list 0.585,
  with 100 entries (19 KB) 0.713 (p90 0.876), 100 entries of 1 KiB each
  (117 KB) 0.939 — parsing every line with cJSON. Heavy with scan 5.716
  → 5.739 without, 5.911 with 100 entries. One watcher tick (driver
  with production flags, 1000 passes over the real scopes, host
  busy): 27 µs for one process up to 0.9 ms for 34, about 15–26 µs per
  process — every 2 s.
- **Evidence, looked at more closely**: in all three snapshots
  `/usr/bin/perl t/json_data.t` (up to 3 746 216 kB, 46.6 % on 2026-09-17) is a
  child of the MakeMaker test harness (`perl -MExtUtils::Command::MM
  -MTest::Harness -e … test_harness(…)`), so it ran under `make test`, which
  the fixed list already calls heavy; the snapshots don't show the shell above it.
  The learned list stays for commands outside the list — the evidence
  above supports it less than it sounds.
- **Limits, in addition**: bash 5.2 `exec`s the last command of a `-c` string
  (checked on reuben, harmless `sleep`: `bash -c 'sleep 2'` and `bash -c
  'cd /tmp && sleep 2'` leave only `sleep`, `'sleep 2; true'` keeps
  bash). Codex starts every call as `bash -c <cmd>` — so a single
  command or `cd x && cmd` runs without a shell from which the text could be
  read, and is **not learned** under Codex; only calls where
  bash stays (pipes, `;` lists, loops) yield argv[2]
  (`test_codex_lone_command_leaves_no_shell`). Claude Code is not affected:
  after the `eval` comes `&& pwd -P …`, the shell stays (as
  recorded). That is why `procs/codex-session.json` runs a
  `;` list since k16 (`prove -lr t/; echo "exit $?"`: bash 7203 → prove 7204),
  as seen live; with `prove -lr t/` alone there would be no bash 7203. The
  slot count judges argv, it stays one slot. If a `claude
  --bg` outlives the session whose scope it shares, the watcher ends with the
  scope owner; the rest keeps running unwatched. A command the watcher reads under Codex but that
  arrives differently from how it was sent ends up as text that never matches.
- **Codex confirmed live** (2026-09-27, codex-cli 0.153.4): argv[2] of the
  shell is the model's command, byte for byte — the snapshot script
  `exec`s exactly that (`sleep 45; echo "lg probe" 'x'`,
  `t/fixtures/shells/codex.json`, `test_recorded_codex_shell`). bash stayed
  for the `;` list, `sleep` ran as a child. How often bash stays depends
  on how the model writes its commands (see limits).
- **Open**: Claude Code's zsh wrapper is not recorded (the same form is
  expected). zsh is not installed on reuben (k14), so it cannot be recorded
  here; nothing is built for it. Under `SHELL=zsh` the
  extraction reads it if it has the same form, otherwise it counts as an
  unknown form: nothing learned, no slot via the learned list.

### Stage 4 — Situational awareness (optional)

`UserPromptSubmit`/`SessionStart`: only when the load is elevated, one status line into
the context. In the normal state loadguard costs **zero** context tokens.

Implemented (k6, `src/loadguard-hook.c`, `hooks/hooks.json`; tests
`t/test_throttle.py` `Context`, `Calibration`, `LiveHost`,
`t/test_hook_passthrough.py`):

- **Signal = exactly the pressure half of k4** (Getty 2026-09-26: like k4, not
  zram): memory `full avg10` ≥ `LOADGUARD_PSI_FULL` or total swap ≥
  `LOADGUARD_SWAP_USED`. `under_pressure()` is the first half of
  `no_room()`, both call it — no second comparison, no threshold of its own.
  **Full slots alone produce no line:** the host is fine then,
  a slot frees up soon, and the deny reason says so at the moment of the
  attempt. No slot scan, so the path reads no foreign process even at rest
  (test: cmdline as a FIFO). `Calibration`: in all 54
  snapshots thrash gets the line, quiet stays silent.
- **Same binary, same launcher:** `hook()` branches on
  `hook_event_name` — `UserPromptSubmit`/`SessionStart` → line or nothing,
  everything else → the PreToolUse path as before (also without
  `hook_event_name`). No Python: UserPromptSubmit runs before every prompt
  of every session.
- **Channel:** `{"hookSpecificOutput":{"hookEventName":"<Event>",
  "additionalContext":"<line>"}}`, without a newline, exit 0. According to the
  hooks docs (code.claude.com/docs/en/hooks, read 2026-09-26), for
  both events plain stdout **and** `additionalContext` land in the context
  as a system reminder: UserPromptSubmit next to the prompt, SessionStart before the first one.
  JSON, because Codex (k11) accepts the same form but rejects unknown
  top-level keys; hence only `hookSpecificOutput`.
- **Synchronous.** Async hooks are not discarded according to the docs: their
  `additionalContext` arrives "on the next conversation turn", and `-p` kills
  them on exit — too late or not at all for SessionStart. Synchronous costs
  ~0.6 ms; Claude's first answer waits for the SessionStart hooks anyway.
  Timeout 5 s like PreToolUse (default on UserPromptSubmit: 30 s; a
  timeout discards the output, the prompt goes through without a line).
- **Confirmed live** (2026-09-26, `claude -p --plugin-dir` with Haiku,
  `LOADGUARD_PSI_FULL=1 LOADGUARD_SWAP_USED=1`, Claude Code 2.1.283): the
  line reaches the model via SessionStart and UserPromptSubmit, it
  quotes both verbatim. The hook refuses `make test`; the model sees
  that as a failed tool call `PreToolUse:Bash hook error: <reason>`
  (`is_error`) and reports the reason correctly. Cost $0.02.
- **Never exit 2:** on UserPromptSubmit exit 2 blocks the prompt and erases
  it. Every path ends with exit 0; test: production binary directly and via
  the launcher, valid, broken, empty and oversized payloads, three
  environments.
- **The line**, English, one line, at most 216 characters (100 % against
  limits of 100 %), facts instead of instructions — the docs warn that text
  phrased as a system instruction can trigger the prompt-injection defense:

  > loadguard: memory pressure full=59.9% (limit 10%), swap 100% used (limit
  > 90%). Heavy commands refused until it eases: prove, make test, builds, new
  > claude -p/--bg. Light commands still run; see `loadguard status`.

  `pressure_figures()` formats the numbers, as in the deny reason (where
  zram follows). **No test run as advice**, not even a small one — for the same reason
  as in the deny reason under pressure (k4 above): every run pulls memory, and a
  command the classifier lets through (a first draft named `perl
  -Ilib t/x.t`) would show the AI the way around the guard. `loadguard status`
  works because `bin/` is on the Bash tool's PATH (k5).
- **No state:** under pressure every prompt gets the line, no dedup —
  simplicity over a few tokens in a rare state.
- **`LOADGUARD_THROTTLE=0` also switches off the line:** without refusing it would
  be wrong. One switch for "refuse nothing, report nothing".
- **Report modes:** no new field. `--report` has `throttle` and
  `pressured`; the line appears exactly when both are `true` (test
  `test_same_pressure_as_the_hook`, including the same numbers as in the deny reason).
- **Cost** (reuben, 1500 runs each alternating against HEAD, `nice`):
  PreToolUse light 0.559 → 0.555 ms, heavy 4.139 → 4.130 ms median —
  unchanged. UserPromptSubmit quiet 0.61 ms, SessionStart 0.68 ms, with
  a line (limits forced via env) 0.60 ms.
- **First session after installation:** the binary is built async; until
  then the launcher outputs nothing — no line, fail-open like PreToolUse.

### CLI

`bin/loadguard`: `status` (PSI, slots, who holds them), `doctor`
(cgroup delegation, busctl, thresholds), `explain '<cmd>'` (how the
hook would decide). The hook entry point is `hooks/loadguard` since k8.

Implemented (k5, `bin/loadguard`, `lib/loadguard/cli.py`; tests
`t/test_cli.py`, `t/test_throttle.py` `Report`):

- **The decision exists once, in the C binary.** It has two report modes,
  one JSON line on stdout each, read-only: `loadguard-hook --report`
  (limits, memory PSI full/some, swap, zram, slots with holders,
  `refuse_heavy`; reads no stdin) and `loadguard-hook --explain`
  (hook payload on stdin; `decision`, `reason` verbatim, plus what was
  measured). Both call `objection()` and `no_room()`, the functions of the
  hook path; a `struct verdict` records how far they got. The
  CLI only formats: it classifies no command, scans no `/proc` and
  compares no value with a limit. Test `test_explain_is_the_hook`:
  4 roots × 5 environments × 8 commands, decision and reason as `decide`,
  byte for byte.
- **Hook mode unchanged:** every call other than exactly `--report` or
  `--explain` is the hook as before; `hooks/loadguard` starts without
  arguments. Measured (1500 calls each, alternating against HEAD, `nice`):
  light 0.609 → 0.605 ms, heavy with scan 4.002 → 4.003 ms median.
- **No root in the production binary:** `report ROOT`/`explain ROOT` exist
  only in the test driver; that is how the formatting is tested on fixtures.
- **Invalid env values:** the report names set variables that change
  nothing (`ignored`) — limits that `env_int` rejects (the same check as
  the hook), and `LOADGUARD_THROTTLE` ≠ `0`. The stage 1 variables are checked by
  `doctor` with `confine.env_int`.
- **`status` does not scan under pressure**, like the hook: the slot line says
  that nothing was read and why (reading cmdline can wait for swap);
  pressure alone refuses. That keeps `status` fast during thrash. In addition the
  CLI waits at most 10 s for the binary and after that not for it to finish — a
  reader waiting for swap does not die immediately.
- **Which binary:** `$CLAUDE_PLUGIN_DATA` if set — according to the
  plugins reference, hooks get it, the Bash tool does not. Otherwise, for an
  installed copy (`<plugins>/cache/<marketplace>/<plugin>/<version>/`),
  its data directory `<plugins>/data/<id>`, id `<plugin>@<marketplace>`
  with everything outside `[A-Za-z0-9_-]` as `-` (reuben: `loadguard-getty`). In the
  checkout `build/` (make), without a build the data directory of a
  `--plugin-dir` session (`loadguard@inline` → `loadguard-inline`). No glob
  `loadguard-*`: on reuben `loadguard-getty` and `loadguard-inline` sit
  side by side, with binaries of different versions. Without a binary
  `status`/`explain` say clearly: pass-through, nothing is refused. A binary
  without report mode (older sources) → a hint, exit 1. The CLI never builds;
  `doctor` names the command.
- **`bin/` is on the Bash tool's PATH** while the plugin is active
  (plugins reference, checked 2026-09-26): the model can call `loadguard status`
  itself. Output is therefore short, `label: value`, ASCII only.
- **`doctor`** checks stage 1 the way `confine()` sees it (`cgroup`,
  `user_bus`, `find_busctl`, `delegated`, `lingering`, `limits`;
  `user_bus`/`find_busctl`/`disabled` pulled out of `confine()` for that),
  plus whether this session sits in a `loadguard-*.scope`; stage 2/3: binary
  present, current (`build.current`: stamp against the sources next to the CLI),
  compiler, report mode, limits. Exit 1 on every FAIL: prerequisite missing,
  binary missing/stale/without report, session not confined although it
  could be, ignored env values. Deliberately switched off (`=0`) is not an error.
  The card named `systemd-run` — since k3 it is `busctl`.
- **Cost of the CLI** (reuben): `status`/`explain` ~47 ms, `doctor` ~80 ms,
  almost all Python startup. The binary alone: `--report` ~4 ms with scan.

### Codex (k11)

The same plugin for Codex (`codex-cli 0.153.4` on reuben), checked against
the sources `rust-v0.153.4` (codex-rs, paths below relative to it). Getty
2026-09-26: if Codex causes real problems, it stays out.

Implemented (k11, `.codex-plugin/plugin.json`, `lib/loadguard/confine.py`,
`src/loadguard-hook.c`; tests `t/test_hook_passthrough.py` `CodexRuns`,
`PluginWiring`, `t/test_confine.py`, `t/test_throttle.py`
`CodexPayloads`, fixtures `t/fixtures/codex/`,
`t/fixtures/procs/codex-*.json`):

- **One `hooks/hooks.json` for both**, as in `~/dev/briefing`.
  `.codex-plugin/plugin.json` has the same fields as
  `.claude-plugin/plugin.json` plus `hooks: "./hooks/hooks.json"`, no
  skills; a test requires every shared field to be equal, so a release
  does not bump only one version. Codex reads the file with
  `deny_unknown_fields` only at the top level (`description`, `hooks`;
  `config/src/hook_config.rs:10-17`), a handler ignores unknown fields —
  including Claude Code's `args` (161-185). The timeout default would be 600 s
  (`hooks/src/engine/discovery.rs:762`); we set 5/10.
- **How Codex starts a hook:** `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`,
  `${PLUGIN_DATA}`, `${CLAUDE_PLUGIN_DATA}` are substituted in the command text
  and set in the environment (`discovery.rs:262-270, 566-568`), then
  `<session shell> -c <command>` (`core/src/session/mod.rs:4666`,
  `hooks/src/engine/command_runner.rs:390-426`), environment = that of codex
  itself (`hooks/src/registry.rs:77`). Without `args` all three
  entries find the data directory via `$CLAUDE_PLUGIN_DATA`; `CodexRuns`
  starts every entry exactly that way. Hooks do not run in the sandbox (started by
  codex itself, own process group, `command_runner.rs:216-242`)
  — busctl reaches the user bus.
  Data directory `~/.codex/plugins/data/<plugin>-<marketplace>`
  (`core-plugins/src/store.rs:141`) = the same name as with Claude Code
  (`loadguard-getty`): `bin/loadguard` finds the binary via the
  installation path.
- **Events:** SessionStart arrives on the first turn, before
  UserPromptSubmit (`core/src/session/turn.rs:264-268`); spawned
  subagents get SubagentStart instead of SessionStart
  (`core/src/hook_runtime.rs:130-146`) — their PreToolUse carries
  `agent_id`/`agent_type`. The shell tool (`exec_command`) reaches
  PreToolUse as `tool_name: "Bash"`, `tool_input: {"command": …}` without
  further fields (`core/src/tools/handlers/unified_exec/exec_command.rs:504-515`).
  Deny JSON and `additionalContext` are the Claude Code forms; the
  output structs reject unknown fields (`hooks/src/schema.rs`), so
  only `hookSpecificOutput` (already since k6). Exit ≠ 0 other than 2, and a
  timeout, do not block in Codex; they appear as hook errors
  (`hooks/src/events/pre_tool_use.rs:278-291`, `command_runner.rs:317-327`)
  — fail-open as with Claude Code. `CodexPayloads`: for
  every root, environment and command the same bytes as with the
  Claude Code payload, deny as well as context line.
- **Confinement:** the session process is the nearest ancestor with `comm` or
  `argv[0]` `claude` **or `codex`** (`session_name()`,
  `find_session()`; npm start: node → `vendor/<triple>/bin/codex`, that one
  counts). Name, slice and idempotence as before; the unit description
  names the harness (`loadguard: codex session <id>`), the status word is
  `no-session`, the CLI says "not run from a Claude Code or Codex session".
  `codex exec` always hosts its session in its own process
  (`exec/src/lib.rs:812`), the TUI embedded
  (`tui/src/lib.rs:255-282`) — **unless** a local app-server daemon
  answers on its socket within 50 ms and the start has no
  overrides such as `-c` (`tui/src/lib.rs:447-470, 860-929`). The daemon
  (`codex app-server [--remote-control] --listen unix://`, detached via `setsid`,
  `app-server-daemon/src/backend/pid.rs:156-182, 413-421`;
  likewise the `codex app-server` of the VS Code extension,
  `app-server/README.md:3`) hosts many threads in one
  process and starts their hooks. **Decided: one shared scope, no
  skipping.** The first thread moves the daemon into
  `loadguard-<thread>-<pid>.scope`, all further ones find it there
  ("already") and share the limit — the same rule as for nested
  `claude -p`. That is never weaker than one scope per session; skipping
  would let exactly these sessions run with no limit at all and their commands
  outside the slice, so invisible to the slot count too. The price:
  threads of different projects slow each other down at `MemoryHigh`, the
  scope carries the name of the first thread and lives as long as the
  daemon. On reuben Remote Control had been on once
  (`~/.codex/app-server-daemon/settings.json`), the daemon was not running on
  2026-09-26.
- **Heavy (incoming):** `codex exec` and its alias `codex e`
  (`codex --help`) are, like `claude -p`/`--bg`, a new headless session:
  heavy at start, no slot. The word is searched for anywhere after
  `codex`, like `-p` with claude — Codex takes global options before the
  subcommand (`codex -m o3 exec …`). The kind is now called `K_AGENT`; its advice
  names both: "Do not start new `claude -p`/`claude --bg` or `codex exec`
  sessions now; do the work in this one." The context line stays: at
  216 characters it sits exactly at its limit (`test_line_stays_short`),
  ", codex exec" does not fit; it is refused anyway.
- **Heavy (running):** Codex executes commands on reuben (`workspace-write`,
  no system bwrap) like this: codex → `codex-linux-sandbox` (symlink to
  codex, `comm` `codex-linux-san`) → bundled `bwrap` (started via
  `/proc/self/fd/N`, `comm` is the number) → `codex-linux-sandbox` again
  as PID 1 of the new namespaces (`comm` `codex`) →
  `/bin/bash -c <cmd>` → prove. No cgroup namespace: everything sits in the
  scope. The helpers have the command in argv only after `--`; what is judged
  is argv[0] — they are light and hide nothing
  (`codex-session.json`, source references in `t/fixtures/README.md`). `bash
  -lc` (before the shell snapshot) is not a recognized inline-code switch:
  the code text is judged like a script path and is heavy only as a bare
  `prove` — then the shell holds the same single slot instead of prove.
- **Cosmetics, left alone (until k14):** Codex appends `. Command: <cmd>` to the reason
  (`core/src/hook_runtime.rs:229-234`); our reason ends with `.`, the
  model reads `run..`. Changing that would mean changing Claude Code's bytes or detecting the
  harness — not trivial enough. Since k14 the hook detects the
  harness (below).
- **Limits:** Codex does not put a plugin's `bin/` on the shell's PATH
  (only package and zsh paths, `core/src/tools/runtimes/mod.rs:118-144`)
  — a Codex model did not find `loadguard status` from the context line
  under that name (since k14 the line no longer names it under Codex).
  In the sandbox `/proc` is that of its own
  PID namespace (`--proc /proc`): `status`/`explain` from there see only their
  own processes; call them from the terminal. Hooks run only after the
  trust prompt, per handler, and a changed hooks.json requires new
  trust (`discovery.rs:676-725, 794-812`); `codex exec` cannot
  grant it.
- **Confirmed live (2026-09-27)** with Getty: codex-cli 0.153.4, loadguard
  0.2.0 from the marketplace `getty-dev`, `LOADGUARD_PSI_FULL=1
  LOADGUARD_SWAP_USED=1`, so that the quiet state counts as pressure — without load.
  Evidence in the session's rollout
  (`~/.codex/sessions/2026/09/27/rollout-2026-09-27T02-13-01-01a0e035-….jsonl`):
  - Confinement: codex (pid 352696) in `loadguard-01a0e035-352696.scope`,
    description `loadguard: codex session 01a0e035-…`.
  - First prompt right after installation: no context line
    (SessionStart and UserPromptSubmit 02:13:04, binary only built at 02:13:07),
    no watcher in this session (confine ran before the build)
    — as described for the first session (learned list, stage 4).
    PreToolUse already took effect at 02:13:09.
  - Second prompt: the context line arrives as a developer message;
    `git status` runs, `make test` and `codex exec` are refused, the
    reason with `. Command: <cmd>` appended — the `..` from above (k14).
  - Codex called the commands via code mode (`exec` →
    `tools.exec_command({cmd: …})`); the hook took effect anyway.
  - Shell: `sleep 45; echo "lg probe" 'x'` ran as `/bin/bash -c <cmd>`,
    argv[2] byte for byte the model's `cmd`
    (`t/fixtures/shells/codex.json`); the rollout names the call
    `/bin/bash -lc <cmd>`, the form before the snapshot script. bash stayed
    (`;` list), `sleep` as a child.
  - Chain in the scope as reconstructed from the sources: codex →
    `codex-linux-sandbox` (argv[0]
    `~/.codex/tmp/arg0/codex-arg0XXXX/codex-linux-sandbox`,
    `--sandbox-policy-cwd … --command-cwd …`) → bwrap (`comm` `3`,
    `bwrap --as-pid-1 --new-session --die-with-parent --ro-bind / / …`) →
    `codex-linux-sandbox` (`comm` `codex`) → `/bin/bash -c <cmd>` →
    `sleep 45`; alongside `codex-code-mode-host` and an MCP server
    (`python3 -I -c …`). `procs/codex-session.json` follows that (k16).
  - Then the entry in `.agents/plugins/marketplace.json` of
    `Getty/marketplace` (cbdd3af): `codex plugin add loadguard@getty`.

### Implemented (k14): Codex stragglers

`src/loadguard-hook.c` (`CODEX_HEADLESS`, `advice()`, `from_codex()`,
`objection()`, `situation()`); tests `t/test_throttle.py` `CodexPayloads`
(reworked), `Decide`, `Slots`, `Matcher`, `t/test_learn.py` `Hook`.
Sources: codex-rs `rust-v0.153.4`.

- **`codex review` is heavy** like `codex exec`: it is `exec` with a
  review task in its own process (`cli/src/main.rs:136-141, 1160-1174`:
  `ExecCli` with `ExecCommand::Review`, `codex_exec::run_main`), without an alias.
  `K_AGENT`, holds no slot; the word is searched for like `exec` anywhere
  after `codex`. The advice names it too: "Do not start new `claude -p`/`claude
  --bg` or `codex exec`/`codex review` sessions now; do the work in this
  one." The context line still names only `claude -p/--bg` (216 characters).
- **Detect the harness, Claude Code's bytes unchanged.** Under Codex
  (a) the reason ends without a final period — Codex appends `. Command: <cmd>`
  (`core/src/hook_runtime.rs:229-234`), the model read `run..` live —, and
  (b) the context line lacks "; see `loadguard status`": no plugin `bin/`
  on the PATH, in the sandbox `/proc` shows only the sandbox. The decision
  and everything else stay the same; `--explain` writes the reason as the
  hook does for the same payload.
- **Signal** (`from_codex()`, no file access: a key lookup in the
  already parsed payload, on SessionStart two `getenv`):
  - PreToolUse, UserPromptSubmit: `turn_id` as a string in the payload. Codex
    sets it on all turn-scoped inputs as a required field ("Codex
    extension", `hooks/src/schema.rs:280-281, 569-570`, test
    `turn_scoped_hook_inputs_include_codex_turn_id_extension`, 1101-1170);
    Claude Code's PreToolUse and UserPromptSubmit have none (recorded
    k7, hooks docs read 2026-09-27).
  - SessionStart: `SessionStartCommandInput` has no `turn_id` and no
    field Claude Code does not send too (`schema.rs:499-510`:
    `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
    `permission_mode`, `source`). Hence the environment: Codex sets
    `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` to the same path for every hook of a plugin
    (`hooks/src/engine/discovery.rs:262-270`) and does not scrub them
    (`protocol/src/shell_environment.rs:14-50`); Claude Code exports
    `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`
    (hooks docs), no `PLUGIN_ROOT`. Under Codex loadguard only runs as a
    plugin (otherwise the launcher finds no `$CLAUDE_PLUGIN_DATA`), so the signal
    is never missing there. Equality rather than mere presence: Claude Code's
    hooks inherit Claude's environment, and a `PLUGIN_ROOT` of another tool
    in it does not count.
  - Rejected: `transcript_path` (`~/.codex/sessions/…/rollout-*`, may be
    `null`, depends on `CODEX_HOME`), the UUIDv7 of the `session_id`,
    `model` names — conventions, not promises; `CODEX_THREAD_ID` is inherited by
    every shell from Codex, including a `claude` started in it.
  - Without the signal Claude Code's form applies, as until k14. A false match
    costs a period or the hint, never a decision.
  - **Risk:** Claude Code already knows `turn_id` (input of
    MessageDisplay, hooks docs 2026-09-27). If its PreToolUse gets
    one too, Claude Code's reason loses the period — then switch to the
    environment signal for all events.
- **Limits, documented instead of built** (Getty: the exact text, no
  reconstruction from argv): a single command cannot be learned under Codex
  (bash `exec`, k15); one learned under Claude Code is refused under
  Codex on entry, but holds no slot while running (learned list,
  limits); Claude Code's zsh wrapper stays unrecorded, zsh is missing on
  reuben.
- **Cost** (reuben, 313 processes, 1500 light and 500 heavy runs each,
  all four cases interleaved per pass, HEAD and new alternating,
  `nice`, process start included; median/p90 in ms): light Claude
  0.502/0.650 → 0.501/0.660, light Codex 0.504/0.657 → 0.504/0.651; heavy
  with scan Claude 4.735/5.724 → 4.733/5.916, Codex 4.749/5.880 →
  4.739/5.831. No measurable difference.
- **Checked:** HEAD against the new test driver, 6780 runs (all pattern and
  light commands of the tests, synthetic and recorded
  Claude payload, both context events, three roots, five environments
  including Claude Code's, `decide` and `explain`): differences only for
  `K_AGENT` commands (advice) and for `codex review` (newly heavy).

## Non-goals

- No replacement for `earlyoom` (runs on reuben) — loadguard keeps things from getting
  that far; earlyoom stays the last guardrail.
- No control over processes outside Claude Code sessions (podman runs
  of other tools). perlbench containers need their own `--memory` limits
  — a separate ticket, not a hook topic.
- No telemetry upload. Everything is local.

## Calibration

Derive thresholds from `~/load-incidents`: which PSI values were in the
snapshots *before* the tipping point? Configurable via env/config file, defaults
conservative for 8 GB / 4 cores.

## Delivery

A repo of its own, later an entry in `~/dev/marketplace` (`Getty/marketplace`), like
`briefing`. Hook runtime normally < 30 ms (it runs before **every** Bash call
of all sessions).

### Language and build (decided 2026-09-26)

Measured (k1): a Python hook costs 183 ms median on reuben, p90 346 ms — almost
all interpreter startup. Hence:

- **Hook path in C** (read payload, measure `/proc`, wrap, decide). JSON
  via **vendored cJSON** (`vendor/cJSON/`, v1.7.19, MIT) — no hand-rolled parsing, no
  `-dev` packages on the target host, only a C compiler.
- **CLI (`status`/`doctor`/`explain`) and tests stay Python** (stdlib). `explain`
  calls the binary so that the decision logic exists exactly once.
  `lib/loadguard/snapshot.py` (k2) stays for CLI and tests.
- **Build on first run** on the target host. As long as there is no binary (no
  compiler, build still running, build failed): **fail-open pass-through**.
  The build must never block a Bash call.

Implemented (k8):

- **Build location `${CLAUDE_PLUGIN_DATA}/bin/loadguard-hook`** — according to the
  plugins reference `~/.claude/plugins/data/<id>/`, survives plugin updates;
  `${CLAUDE_PLUGIN_ROOT}` changes with every version. Stale means:
  the stamp next to the binary (SHA-256 over sources, flags, compiler path/size/
  mtime) no longer matches — an update with changed sources rebuilds, merely
  copied files with a new mtime do not.
- **SessionStart** (`hooks/loadguard-build`, `async`) forks a detached child
  (own session, stdio to `/dev/null`, `nice 10`) that builds atomically under `flock`
  (temp + rename, 120 s timeout). Without a compiler nothing; build failed →
  old binary gone → pass-through. Detached because `claude -p` kills async hooks on
  exit — otherwise purely headless sessions would never finish building.
- **PreToolUse** starts the sh launcher `hooks/loadguard` in exec form
  (`args: ["${CLAUDE_PLUGIN_DATA}"]`): binary present → `exec`, otherwise `exit 0`.
  Registering the binary directly would save ~2 ms, but until the first build (and
  without a compiler forever) it would show a visible hook error message
  (exit 127) on every Bash call.
- **The Python hook is deleted**: without a binary, pass-through is exactly
  `exit 0`; that needs no interpreter for 83–183 ms.
- **Windows: silently off** (windows-developer k6). Claude Code does not start
  a script without an extension there (ENOENT); there is no platform switch for hooks.
  An exec form without an extension, however, starts
  `<command>.exe` on Windows. Next to each of the three scripts there is therefore a copy of
  `winlaunch` (`winlaunch/`, reproducibly built with zig, rebuilt and compared
  in CI). It reads `# winlaunch:` lines from the script
  next to it; loadguard's scripts have none, so every hook ends with exit 0
  and no output. For that, `loadguard-confine` also runs in exec form
  (`args: []`); Codex ignores `args` and sees the same command text.
