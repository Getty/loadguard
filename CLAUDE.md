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
| `hooks/hooks.json` | Hook-Registrierung (SessionStart: Einsperren + Build, PreToolUse auf Bash) |
| `hooks/loadguard` | sh-Starter: `exec` des C-Binarys, ohne Binary `exit 0` |
| `hooks/loadguard-confine` | SessionStart: schiebt die claude-Session in einen systemd-User-Scope mit Limits |
| `hooks/loadguard-build` | SessionStart: baut das Binary nach `${CLAUDE_PLUGIN_DATA}/bin/`, abgekoppelt |
| `src/loadguard-hook.c` | Hook-Pfad in C (verweigert schwere Befehle unter Druck oder bei vollen Slots, sonst still; schreibt Befehle nie um; Report-Modi für die CLI) |
| `vendor/cJSON/` | cJSON unverändert, Version und SHA256 in `README` |
| `Makefile` | `make` → `build/bin/`, `make test`, `make clean` |
| `bin/loadguard` | CLI (`status`, `doctor`, `explain`) |
| `lib/loadguard/` | Python für CLI, Build und Tests (`snapshot.py`: Messung, `build.py`: Build/Staleness, `confine.py`: Session-Scope, `cli.py`: CLI-Ausgabe aus den Report-Modi des Binarys) |
| `t/` | Tests (`python3 -m unittest discover -s t -v`), Fixtures aus `~/load-incidents/` |

Hook-Pfad in C (vendored cJSON, Build beim ersten Lauf, fail-open ohne Binary);
CLI und Tests in Python 3, nur stdlib. Begründung: `docs/design.md` → Sprache und
Build. `~/dev/briefing` dient als Referenz für Plugin-Aufbau, `hooks.json` und
`${CLAUDE_PLUGIN_ROOT}`.
