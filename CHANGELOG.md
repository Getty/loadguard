# Changelog

## Unreleased

- Repo scaffold: design, agent team, karr board.
- PreToolUse hook on Bash (`hooks/hooks.json`, `hooks/loadguard`): fail-open
  pass-through skeleton, 5 s timeout, no decisions yet. `updatedInput` replaces
  `tool_input` outright, no merge, and takes effect without `permissionDecision`
  — a rewrite must copy every key of the incoming `tool_input`, not just
  `command` (pinned against a recorded Claude Code 2.1.283 session, k7).
  Covered by 15 tests against payload fixtures in `t/fixtures/`, the plain,
  heredoc and background Bash cases now recorded rather than reconstructed.
- `lib/loadguard/snapshot.py`: subprocess-free host pressure reader
  (`read_snapshot`, `/proc/loadavg`, `/proc/meminfo`, `/proc/pressure/*`,
  `/sys/block/zram*`) plus `parse_incident` for `~/load-incidents/*.txt`.
  Any missing or unreadable source leaves its field `None` instead of
  raising. Covered by 21 tests against recorded and reconstructed fixtures.
