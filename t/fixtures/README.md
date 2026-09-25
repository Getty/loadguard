# Hook payload fixtures

**All payloads here are reconstructed, not recorded.** They follow the PreToolUse
input schema at https://code.claude.com/docs/en/hooks as read on 2026-09-26. No
Claude Code session was instrumented to capture them; replace them with recorded
payloads once a capture path exists that does not touch the live `~/.claude`.

| File | Case |
|---|---|
| `bash-plain.json` | light Bash command |
| `bash-heredoc.json` | heredoc, mixed quotes, `$HOME`, `cd`, `&&`, subshell |
| `bash-background.json` | `run_in_background: true` |
| `bash-subagent.json` | fired inside a subagent (`agent_id`, `agent_type`) |
| `bash-no-command.json` | Bash payload without `tool_input.command` |
| `read-tool.json` | non-Bash tool |
| `broken.json` | truncated JSON |
| `empty.json` | empty stdin |
| `not-an-object.json` | valid JSON, not an object |
| `invalid-utf8.json` | bytes that are not UTF-8 |

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
