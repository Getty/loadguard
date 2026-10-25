# loadguard House Rules

The shared house rules come from skilletor — bundle `getty-house@getty`: engineering
discipline, the delegation lock, the publish gate, karr coordination. They load as
`.claude/rules/.local.*.md`; if they are missing, run `skilletor sync` and publish nothing
until they load. This file adds what is true only here, and wins where it differs.

## What this repo is

Claude Code plugin that measures and limits the load AI processes put on the host and
reports it back to the AI so it can steer. Read first: `docs/design.md`. Python stdlib
only; C with vendored cJSON only.

## Agent team

| Task | Agent |
|---|---|
| Implement / refactor / debug / test | `loadguard-worker` |
| Commits, `Changes`, card → done, release audit | `loadguard-release-manager` |
| Read-only research, audit, gap analysis | `loadguard-worker` ("read-only, change nothing") |

Behavior-relevant = the hook, the CLI, the decision logic and their tests. Main agent's
lane here: plan, cut cards, dispatch, review diffs, run tests, talk to Getty.

## Release

Beyond the shared publish gate: marketplace publication (`~/dev/marketplace`) and
installing the plugin into Getty's live `~/.claude` each need Getty's explicit go-ahead.
Installing a half-built PreToolUse hook on Bash can wedge every session on the host.

## Deviations from the house rules

- **At most one subagent at a time** — never spawn owning agents in parallel, even for a
  task spanning several lanes. Parallel workers on this box are part of the problem this
  repo exists to solve.

## Hazards — this host is the patient

- **reuben has 4 cores, ~8 GB RAM, 3.2 GB zram + 8 GB swapfile** and has been
  power-cycled repeatedly under memory thrash (evidence: `~/load-incidents/`). Never
  produce real memory or CPU pressure to test loadguard — use fixtures from the incident
  snapshots.
- **A PreToolUse hook on Bash runs before every shell call of every session.** A bug that
  exits non-zero or hangs blocks all agents on the host. Fail open, set a hook timeout,
  and test the hook binary against recorded payloads before wiring it.
