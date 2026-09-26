# Changelog

## Unreleased

- README gets its title image (k9): `assets/github.png` at the top, linked to
  the repo, quantized to a 256-colour palette to stay under GitHub's 1 MB
  social-preview limit (805 KB, was 3.17 MB RGB). Install now covers the
  first session's background build (nothing is refused until it exists),
  `loadguard doctor` to check it, and updating (`claude plugin update
  loadguard@getty`, new session, rebuild on changed sources). Requirements
  note Python 3 is also needed for the CLI. Documents how a refusal actually
  reaches the model: a failed tool call, `PreToolUse:Bash hook error:
  <reason>`.
- Codex support (k11), built against the Codex 0.153.4 sources; the first
  live run under Codex is still ahead, and the Codex marketplace entry is
  not published yet. A new `.codex-plugin/plugin.json` points Codex at the
  same `hooks/hooks.json` (a test keeps its shared fields, the version
  first, equal to `.claude-plugin/plugin.json`'s). Codex fires the same
  three events and takes the same answers: the tests feed the hook binary
  payloads built from Codex's own structs and require the Claude Code
  bytes back, deny and context line alike, and run every `hooks.json`
  entry the way Codex does — without `args`, from `$CLAUDE_PLUGIN_DATA`
  alone. A Codex session is confined like a Claude Code one: the session
  process is now the nearest `claude` **or `codex`** above the hook, the
  unit's description names which (`loadguard: codex session <id>`), and a
  shared `codex app-server` daemon, which hosts many sessions in one
  process, is confined once and shares that scope with all of them —
  never left out. `codex exec` (and `codex e`) is heavy like `claude -p`:
  refused under pressure or with full slots, holding no slot while it
  runs, and the advice for both now reads ``Do not start new `claude
  -p`/`claude --bg` or `codex exec` sessions now``. Codex's sandbox chain
  (`codex-linux-sandbox`, `bwrap`, the helper again inside the
  namespaces) counts as light and hides nothing: a `prove` inside it is
  one slot. Wording is harness-neutral where it named claude alone:
  `loadguard status`/`doctor` say "not run from a Claude Code or Codex
  session", the confine hook's status word is `no-session`. Under Codex
  the CLI is not on the model's `PATH` (Codex adds no plugin `bin/`); it
  finds the binary from its install path under `~/.codex/plugins` as it
  does under `~/.claude/plugins`.
- Under memory pressure the model now hears it before it tries (k6): on
  `UserPromptSubmit` and `SessionStart` the hook binary adds one line of
  context, as `hookSpecificOutput.additionalContext` —
  `` `loadguard: memory pressure full=59.9% (limit 10%), swap 100% used (limit
  90%). Heavy commands refused until it eases: prove, make test, builds, new
  claude -p/--bg. Light commands still run; see `loadguard status`.` `` — and
  nothing at all otherwise: a calm host costs no context. Like the refusal
  under pressure, it suggests no test run at all.
  It is the refusals' own pressure test (memory PSI `full avg10` at
  `LOADGUARD_PSI_FULL` or all swap at `LOADGUARD_SWAP_USED`), run by the
  same function; busy heavy slots alone add no line, and the path reads no
  process. Every prompt gets the line while the pressure lasts, nothing is
  remembered between prompts; `LOADGUARD_THROTTLE=0` turns it off along
  with the refusals. Both hooks run the existing starter synchronously with
  a 5 s timeout, and the binary branches on `hook_event_name`: `PreToolUse`
  behaves and costs as before (0.555 ms light, 4.13 ms heavy on reuben),
  the new path takes about 0.6 ms and reads only `/proc/pressure/memory`
  and `/proc/meminfo`. It never exits 2, which on `UserPromptSubmit` would
  erase the user's prompt. Checked against every incident snapshot: the
  thrashing ones get the line, the calm ones nothing. 21 new tests.
- New CLI `bin/loadguard` (k5), on the Bash tool's `PATH` while the plugin
  is enabled, so the model can run it too: `loadguard status` (memory PSI
  full/some, swap, zram, the limits in effect, heavy slots busy and who holds
  them, whether this session is confined), `loadguard explain '<cmd>'` (what
  the hook would do with this Bash command now, with the exact reason the
  model would see; nothing runs) and `loadguard doctor` (cgroup v2, memory
  delegation, linger, user bus and `busctl`, hook binary present and built
  from these sources, compiler, both stages on or off, environment values
  that change nothing; exit 1 if something that should work does not). The
  decision still exists only in the C hook: the binary got two read-only
  report modes, `--report` and `--explain`, that print one line of JSON from
  the same functions the hook runs, and the CLI only formats it — a test
  checks that `explain` gives the hook's verdict and reason byte for byte.
  Hook mode (any other call) is unchanged: 0.605 ms median for a light
  command, 4.0 ms for a heavy one on reuben, as before. Under memory pressure
  `status` does not scan processes, like the hook. Without a hook binary
  `status` and `explain` say the hook is passing everything through. The
  CLI finds the binary through `$CLAUDE_PLUGIN_DATA`, else the data
  directory of the installed copy it belongs to, else a checkout's `build/`.
  43 new tests.
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
  `prove -lr t/ in ~/dev/sunriser`) and what to do: wait, light commands
  still run, no new `claude -p`; with every slot busy, a smaller run for the
  retry (`prove -l t/foo.t` instead of `-r`), which needs a slot too. Under
  memory pressure it suggests no test run at all, not even a single file:
  every run adds memory, and one `perl` one-liner held 3.8 GB in the
  incidents. Light commands still read
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
