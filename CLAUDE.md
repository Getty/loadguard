# loadguard — CLAUDE.md

Claude Code plugin that measures and limits the load of AI processes on the host and
reports it back to the AI so it can steer against it. Born out of the thrash reboots
of `reuben` (evidence: `~/load-incidents/`).

- **Design, stages, open questions:** [`docs/design.md`](docs/design.md) — read first.
- **Rules + delegation:** shared house rules via the skilletor bundle
  `getty-house@getty`; lanes and hazards in `.claude/rules/loadguard-rules.md` (auto-loaded).
- **Board:** `karr list --compact` — the cards follow the stages from the design.

## Delegation

| Task | Agent |
|---|---|
| Hook, CLI, decision logic, tests | `loadguard-worker` |
| Commits, `Changes`, card → done, release audit | `loadguard-release-manager` |

Only the release-manager commits. The agents carry their skills via
`briefing.skills` (`.claude/agents/`); skill sources under `.claude/skills/`.

## Layout

| Path | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest, no `version` (Claude Code takes it from the commit) |
| `.codex-plugin/plugin.json` | Codex manifest, holds the version, same `hooks/hooks.json`; shared fields kept equal by a test |
| `hooks/hooks.json` | Hook registration (SessionStart: confinement + build + status line, UserPromptSubmit: status line, PreToolUse on Bash) |
| `hooks/loadguard` | sh launcher for PreToolUse, UserPromptSubmit and SessionStart: `exec` of the C binary, `exit 0` without a binary |
| `hooks/loadguard-confine` | SessionStart: moves the claude session into a systemd user scope with limits, then starts the watcher of the learned list |
| `hooks/loadguard-build` | SessionStart: builds the binary into `${CLAUDE_PLUGIN_DATA}/bin/`, detached |
| `src/loadguard-hook.c` | Hook path in C (refuses heavy commands under pressure or when slots are full, status line only under pressure, otherwise silent; never rewrites commands; report modes for the CLI; `--watch PID`: per-scope watcher, writes the learned list) |
| `vendor/cJSON/` | cJSON unmodified, version and SHA256 in `README` |
| `Makefile` | `make` → `build/bin/`, `make test`, `make clean` |
| `bin/loadguard` | CLI (`status`, `doctor`, `explain`, `learned`, `forget`) |
| `lib/loadguard/` | Python for CLI, build and tests (`snapshot.py`: measurement, `build.py`: build/staleness, `confine.py`: session scope, `learn.py`: read/trim the learned list, start the watcher, `cli.py`: CLI output from the binary's report modes) |
| `t/` | Tests (`python3 -m unittest discover -s t -v`), fixtures from `~/load-incidents/` |

Hook path in C (vendored cJSON, built on first run, fail-open without a binary);
CLI and tests in Python 3, stdlib only. Rationale: `docs/design.md` → Language and
build. `~/dev/briefing` serves as the reference for plugin structure, `hooks.json` and
`${CLAUDE_PLUGIN_ROOT}`.
