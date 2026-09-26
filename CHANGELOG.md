# Changelog

## Unreleased

- The PreToolUse hook now refuses heavy commands, with a reason for the model
  (k4). Heavy: `prove`, `make … test`, `dzil test|build|release`, `cpanm`,
  `docker|podman build|run`, `cargo build|test`, `npm test`, `perlbench`,
  `claude -p|--print|--bg` — matched in command position (after `;`, `&&`,
  `|`, newlines, `VAR=x`, `nice`/`timeout`/`env` …), not in quotes, comments
  or heredoc bodies. A heavy command is refused when memory PSI `full avg10`
  is at least 10 % or all swap at least 90 % used, or when `max(1, nproc/2)`
  heavy commands already run in confined sessions (`app-loadguard.slice`,
  every session). Running commands are counted by one pass over `/proc`,
  judged by argv (an interpreter's script, never Claude Code's `bash -c`
  wrapper text or npm's process title as raw text) and only the topmost heavy
  process of a chain, so `prove` with its perl children or a recursive
  `make test` hold one slot; a nested `claude -p`/`--bg` holds none. Under
  memory pressure the hook does not read other processes at all — their
  cmdline may have to come back from swap, and a timed-out hook would let the
  command run. The reason, in English, gives the figures (PSI vs limit, swap,
  zram as information, busy/total slots and who holds them, e.g.
  `prove -lr t/ in ~/dev/sunriser`) and an alternative (wait; `prove -l
  t/foo.t` instead of `-r`; no new `claude -p`). Light commands still read
  nothing but stdin. Thresholds from the 54 incident snapshots: calm memory
  `full avg10` <= 2.03 % and swap <= 68 %, thrash >= 45.47 % and >= 92 %.
  Tunable through `LOADGUARD_PSI_FULL`, `LOADGUARD_SWAP_USED`,
  `LOADGUARD_HEAVY_SLOTS`; `LOADGUARD_THROTTLE=0` turns refusing off. Cost on
  reuben (297 processes): 0.53 ms median for a light command, 3.6 ms for a
  heavy one with the full scan, 0.6 ms under pressure. Covered by 45 tests
  against recorded and reconstructed `/proc` trees, process specs in
  `t/fixtures/procs/` and every incident snapshot — none puts load on the
  host.

## 0.1.1 - 2026-09-26

- README.md (problem, mechanism, stages, status) and LICENSE (Artistic 2.0,
  Copyright (c) 2026 Torsten Raudssus) added; the repo is public
  (github.com/Getty/loadguard). Title image still pending.
- SessionStart now confines each session: a new hook (`hooks/loadguard-confine`,
  `lib/loadguard/confine.py`) moves the claude process into its own systemd
  user scope (`app-loadguard.slice/loadguard-<session>-<pid>.scope`), with
  `MemoryHigh`/`MemoryMax`/`MemorySwapMax` at 30/40/10% of `MemTotal` and
  `CPUWeight` 50 — tunable through `LOADGUARD_MEMORY_HIGH`,
  `LOADGUARD_MEMORY_MAX`, `LOADGUARD_MEMORY_SWAP_MAX` and
  `LOADGUARD_CPU_WEIGHT`. `busctl StartTransientUnit` carries the claude PID
  alone, with `Delegate=yes`; descendants claude already started (MCP
  servers) are moved in afterwards with `AttachProcessesToUnit`, one PID at a
  time if the batch fails — a PID still listed when systemd moves it can
  vanish first and fail the whole unit asynchronously while the call itself
  still returns success, which counts as `unconfirmed`. `OOMPolicy=continue`
  keeps a kernel OOM kill of the outlier from ending the scope, and with it
  claude. Commands are never rewritten. A session already inside a
  `loadguard-*.scope` (resume/compact, a nested `claude -p`) is left alone;
  without systemd, cgroup v2 memory delegation, a user bus, or **linger**
  (`/var/lib/systemd/linger/$USER`) the session runs unconfined — without
  linger the user manager, and with it the scope, would not outlive a
  `claude` left running in `screen`/`tmux` past the last logout.
  `LOADGUARD_CONFINE=0` (only that exact value) turns confinement off
  outright. Covered by 54 tests against a fixture `busctl` and a live scope
  around a real `sleep`.
- Repo scaffold: design, agent team, karr board.
- PreToolUse hook on Bash is now a compiled C binary
  (`src/loadguard-hook.c`, vendored cJSON v1.7.19 in `vendor/cJSON/`) instead
  of Python: still a fail-open pass-through with no decisions yet, 5 s
  timeout. `updatedInput` replaces `tool_input` outright, no merge, and takes
  effect without `permissionDecision` — a rewrite must copy every key of the
  incoming `tool_input`, not just `command` (pinned against a recorded Claude
  Code 2.1.283 session, k7). `hooks/loadguard` is now a small `sh` starter
  that `exec`s the binary from `${CLAUDE_PLUGIN_DATA}/bin` and otherwise
  exits 0; a new SessionStart hook (`hooks/loadguard-build`,
  `lib/loadguard/build.py`) builds it in the background on first run and
  whenever sources or compiler change, without ever blocking a Bash call.
  Median hook runtime on reuben: 3.3 ms, p90 9 ms (was 183 ms median with
  Python). Covered by 44 tests against payload fixtures in `t/fixtures/` and
  a real-compiler build.
- `lib/loadguard/snapshot.py`: subprocess-free host pressure reader
  (`read_snapshot`, `/proc/loadavg`, `/proc/meminfo`, `/proc/pressure/*`,
  `/sys/block/zram*`) plus `parse_incident` for `~/load-incidents/*.txt`.
  Any missing or unreadable source leaves its field `None` instead of
  raising. Covered by 21 tests against recorded and reconstructed fixtures.
