# loadguard — CLAUDE.md

Claude-Code-Plugin, das die Last von KI-Prozessen auf dem Host misst, begrenzt und
der KI zurückmeldet, damit sie gegensteuern kann. Entstanden aus den
Thrash-Reboots von `reuben` (Beweise: `~/load-incidents/`).

- **Design, Stufen, offene Fragen:** [`docs/design.md`](docs/design.md) — zuerst lesen.
- **Regeln + Delegation:** `.claude/rules/loadguard-rules.md` (auto-geladen).
- **Board:** `karr list --compact` — die Karten folgen den Stufen aus dem Design.

## Delegation

| Aufgabe | Agent |
|---|---|
| Hook, CLI, Entscheidungslogik, Tests | `loadguard-worker` |
| Commits, CHANGELOG, Karte → done, Release-Audit | `loadguard-release-manager` |

Nur der Release-Manager committet. Die Agenten tragen ihre Skills über
`briefing.skills` (`.claude/agents/`); Skill-Quellen unter `.claude/skills/`.

## Layout

| Pfad | Inhalt |
|---|---|
| `.claude-plugin/plugin.json` | Plugin-Manifest |
| `hooks/hooks.json`, `hooks/loadguard` | Hook-Registrierung und -Einstieg |
| `bin/loadguard` | CLI (`status`, `doctor`, `explain`) |
| `lib/loadguard/` | Gemeinsamer Code für Hook und CLI (`snapshot.py`: Messung) |
| `t/` | Tests (`python3 -m unittest discover -s t -v`), Fixtures aus `~/load-incidents/` |

Hook-Pfad in C (vendored cJSON, Build beim ersten Lauf, fail-open ohne Binary);
CLI und Tests in Python 3, nur stdlib. Begründung: `docs/design.md` → Sprache und
Build. `~/dev/briefing` dient als Referenz für Plugin-Aufbau, `hooks.json` und
`${CLAUDE_PLUGIN_ROOT}`.
