# loadguard House Rules

Apply to every task in this repository. Loaded automatically for the orchestrating
agent; subagents get their knowledge from the skills in `briefing.skills`.

## Engineering discipline

1. **Think before coding** — state assumptions, ask when unsure, stop when confused.
2. **Simplicity first** — minimum code, nothing speculative; Python stdlib only, C with vendored cJSON only.
3. **Surgical changes** — touch only what the card needs.
4. **Goal-driven** — define success criteria, loop until verified.
5. **Fail loud** — "done" is wrong if anything was skipped; "tests pass" is wrong if
   any were skipped.
6. **A red test is a claim before it is a failure** — say what it asserts before
   changing code to make it green.

## Delegation

- **You can spawn subagents** (orchestrating main agent): do not touch the hook, the
  CLI or the decision logic yourself — delegate.

  | Task | Agent |
  |---|---|
  | Implement / refactor / debug / test | `loadguard-worker` |
  | Commits, `Changes`, card → done, release audit | `loadguard-release-manager` |

  Your lane: plan, cut cards, dispatch, review diffs, run tests, talk to Getty.
- **You are a `loadguard-*` agent**: the lock does not apply; work your lane.

**Only `loadguard-release-manager` commits.** Workers leave a commit-ready tree and a
report. Main agent: after a worker hands off, dispatch the release manager.

## Coordination — karr

This repo has its own karr board. You pick, claim, create and route cards; the worker
only works the card it was handed and ends at `review`; the release manager moves it
to `done` after the commit. Serialize board mutations when fanning out.

## Never without permission

`git push`, tagging, marketplace publication (`~/dev/marketplace`), and installing
the plugin into Getty's live `~/.claude` — each needs Getty's explicit go-ahead.
Installing a half-built PreToolUse hook on Bash can wedge every session on the host.

## Hazards — this host is the patient

- **reuben has 4 cores, ~8 GB RAM, 3.2 GB zram + 8 GB swapfile** and has been power-cycled repeatedly
  under memory thrash (evidence: `~/load-incidents/`). Never produce real memory or
  CPU pressure to test loadguard — use fixtures from the incident snapshots.
- **At most one subagent at a time** here. Parallel workers on this box are part of
  the problem this repo exists to solve.
- **A PreToolUse hook on Bash runs before every shell call of every session.** A bug
  that exits non-zero or hangs blocks all agents on the host. Fail open, set a hook
  timeout, and test the hook binary against recorded payloads before wiring it.
