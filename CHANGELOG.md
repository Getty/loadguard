# Changelog

## Unreleased

- Repo scaffold: design, agent team, karr board.
- PreToolUse hook on Bash (`hooks/hooks.json`, `hooks/loadguard`): fail-open
  pass-through skeleton, 5 s timeout, no decisions yet. Covered by 12 tests
  against reconstructed payload fixtures in `t/fixtures/`.
- `lib/loadguard/snapshot.py`: subprocess-free host pressure reader
  (`read_snapshot`, `/proc/loadavg`, `/proc/meminfo`, `/proc/pressure/*`,
  `/sys/block/zram*`) plus `parse_incident` for `~/load-incidents/*.txt`.
  Any missing or unreadable source leaves its field `None` instead of
  raising. Covered by 21 tests against recorded and reconstructed fixtures.
