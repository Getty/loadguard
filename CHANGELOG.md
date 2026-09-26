# Changelog

## Unreleased

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
