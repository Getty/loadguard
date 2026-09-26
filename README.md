[![loadguard — a llama in a guard's cap and dungarees holds up a hand and lowers a barrier in front of a robot choking on a heap of capsules, while pipes drop single capsules to small robots cheering at their desks](https://raw.githubusercontent.com/Getty/loadguard/main/assets/github.png)](https://github.com/Getty/loadguard)

# loadguard

> **The model can't feel the box swapping. The kernel can.**

`loadguard` is a Claude Code plugin that keeps AI-issued shell commands from
taking down the host they run on. Each Claude Code session runs inside its own
systemd scope with memory and CPU limits, so one runaway command hits a wall
inside that session instead of dragging the whole machine into swap.

When memory runs short, or too many heavy commands already run across all
sessions, it refuses the next heavy one — a test suite, a build, a new
headless `claude` — and tells the model why, with the numbers and a lighter
alternative. While memory stays short, the model hears it with every prompt,
before it tries; when the host is calm, loadguard adds nothing to the
context.

Linux only. The same plugin runs under Codex; see [Codex](#codex).

## The problem this solves

An agent that runs `bash` does not see the machine. It sees an exit code, some
output, and — when the host is thrashing — a command that takes a very long
time. So it waits, or starts another session to help, and the load compounds.

loadguard started from a 4-core, 8 GB workstation that had to be power-cycled
repeatedly while several Claude Code sessions worked on it. A watchdog recorded
54 snapshots whenever the load average crossed 20. The pattern before each
hard reboot:

- **Swap full.** 11 GB of swap (zram plus a swapfile), 100 % used in 33 of the
  54 snapshots.
- **Memory pressure off the scale.** PSI memory `full avg10` — the share of
  time *every* task was stalled waiting for memory — above 45 % in every thrash
  snapshot, up to 84 %. In the calm ones it stayed at about 2 % at most; there
  was nothing in between.
- **Load average up to 85** on 4 cores, most of it tasks stuck waiting for
  pages to come back from swap.
- **One command was enough.** In one snapshot a single `perl -e` one-liner
  held 3.8 GB resident — 48 % of RAM. Not a test suite, not a build: a
  harmless-looking one-liner.

That last point shapes the design. Recognising "heavy" commands by pattern is
not enough; the limit has to cover every command an agent runs. A pattern can
only decide how strict to be.

## How it works

On `SessionStart`, loadguard moves the `claude` process (or `codex`) into a
transient systemd user scope:

```
app-loadguard.slice/loadguard-<session>-<pid>.scope
```

with `MemoryHigh`, `MemoryMax`, `MemorySwapMax` and `CPUWeight` set (defaults
below). Everything the session starts afterwards — shell commands, subagents,
MCP servers — inherits the scope. A command that outgrows it is throttled at
`MemoryHigh` and, at `MemoryMax`, killed by the kernel inside the scope, which
picks the largest process there — normally the outlier, not `claude`.
`OOMPolicy=continue` keeps that kill from taking the rest of the session with
it. On the workstation above, the defaults leave no room for the 3.8 GB
one-liner next to `claude`: it would be killed alone.

**Why the session and not each command.** The obvious design is a `PreToolUse`
hook that rewrites every command into `systemd-run --scope … -- bash -c '…'`.
It was built and tested live, and it does not work:

- Claude Code checks permission rules against the **rewritten** command. Every
  `Bash(git:*)`-style allow rule you have stops matching.
- Claude Code runs each command in a shell that sources a snapshot of your
  shell and records the working directory afterwards. A child shell inside a
  scope loses `cd` and those functions.

So loadguard never rewrites a command. Permissions, working directory, exit
codes, output and `run_in_background` behave exactly as without it; the limit
costs nothing per command.

### Refusing heavy commands

Before every `Bash` call a small C hook looks at the command. Light commands —
`git status`, `ls`, `cat`, anything not on the list below — pass at once,
without the hook reading a single file. A **heavy** command is refused when

- the host is under memory pressure: PSI memory `full avg10` at or above 10 %,
  or all swap (zram and swapfile together) at least 90 % used; or
- every **heavy slot** is taken: at least `max(1, nproc/2)` heavy commands
  already run in confined sessions — any session, not just this one.

Heavy means the command runs `prove`, `make … test`, `dzil test|build|release`,
`cpanm`, `docker|podman build|run`, `cargo build|test`, `npm test`,
`perlbench`, or starts a headless agent session: `claude -p`/`--print`/`--bg`
or `codex exec`. It is recognised in command position —
`cd x && FOO=1 nice prove -lr t/` is heavy, `git log --grep=prove` or a
heredoc that mentions `make test` is not. A running command holds one slot
however many processes it spawns; a nested `claude -p` or `codex exec` holds
none, but what it runs does.

The model sees the refusal as a failed tool call,
`PreToolUse:Bash hook error: <reason>`, with the reason telling it what is
going on:

```
loadguard: heavy command refused (dzil test): 2/2 heavy slots busy (prove -lr t/ in ~/dev/sunriser; make test in ~/dev/p5-foo), memory pressure full=0.0% (limit 10%), swap 60% used (limit 90%), zram 97% full.
Wait for one to finish, then retry; light commands (git status, ls, cat) still run. When you retry, run a single test file instead of the whole suite.
```

A smaller run is advice for the retry, not a way around the wait: it is a
heavy command too. Under memory pressure the reason suggests no test run at
all, not even a single file — every run adds memory, and one `perl` was
enough to take that machine down. It says to wait; light commands still run.

The thresholds come from the 54 snapshots above: memory `full avg10` never
exceeded 2.03 % in the calm ones and never fell below 45.47 % in the thrashing
ones; swap stayed at or below 68 % calm and reached 92–100 % thrashing. The
hook costs about 0.5 ms for a light command and under 5 ms for a heavy one on
that 4-core machine. Under memory pressure it does not look at other
processes at all — reading them can itself stall on swap.

### Telling the model before it tries

While memory is under pressure — the same test as above: PSI memory
`full avg10` at or above 10 %, or all swap at least 90 % used — every prompt
and every session start carries one line for the model:

```
loadguard: memory pressure full=59.9% (limit 10%), swap 100% used (limit 90%). Heavy commands refused until it eases: prove, make test, builds, new claude -p/--bg. Light commands still run; see `loadguard status`.
```

Otherwise loadguard says nothing: no line, not a single token of context.
Busy heavy slots alone do not add the line — the host is fine then, a slot
frees up soon, and a refused command says so when it happens. The line is
repeated on every prompt while the pressure lasts. It reaches the model as
`additionalContext` of the `UserPromptSubmit` and `SessionStart` hooks, from
the same C binary, which reads two kernel files for it and no process list
(about 0.6 ms). `LOADGUARD_THROTTLE=0` turns it off along with the refusals.

Things loadguard leaves alone on purpose:

- A session that is already in a `loadguard-*.scope` — a resumed or compacted
  session, or a `claude -p` started from a confined one. A nested `claude`
  shares its parent's limit instead of escaping it.
- Anything it cannot do cleanly. No systemd, no cgroup v2, no delegated memory
  controller, no linger, any error: the session runs unconfined, and nothing
  is printed. A broken guard must not break every session on the host.

## Status

Built:

- **Session confinement** (above), with limits from environment variables.
- **The `PreToolUse` hook on `Bash`**, a small C binary compiled on the first
  `SessionStart`. It refuses heavy commands under memory pressure or with
  every heavy slot busy (above) and lets everything else through unchanged.
  Until the binary exists (still building, no compiler, build failed) the
  hook exits 0 and nothing is refused.
- **The pressure line** (above) on `UserPromptSubmit` and `SessionStart`,
  from the same binary: one line while memory is under pressure, nothing
  otherwise.
- **The CLI** (below): `loadguard status`, `doctor`, `explain '<cmd>'`.
- **Codex support** (below), built against the Codex 0.153.4 sources and
  tested on reconstructed payloads; the first live run under Codex is still
  ahead.

Not built yet:

- **Learning heavy commands** from what actually used a lot of memory in a
  session, beyond the fixed list.

The design, with the measurements behind each decision, is in
[`docs/design.md`](docs/design.md) (German).

## Requirements

- **Linux with cgroup v2 and a systemd user manager.** The memory controller
  must be delegated to `user@<uid>.service`; check with
  `cat /sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`
  — it has to list `memory`. `busctl` comes with systemd.
- **Linger** for your user: `loginctl enable-linger`. Without it the user
  manager stops at your last logout and takes its scopes along — including a
  `claude` you left running in `screen` or `tmux`. loadguard therefore does
  not confine without linger.
- **Python 3** for the `SessionStart` hooks and the CLI. Standard library only.
- **A C compiler** (`$CC`, else `cc` or `gcc`) for the first build of the hook.
  It builds in the background into the plugin's data directory and rebuilds
  when its sources change. Without a compiler the hook stays a pass-through.

macOS and containers without a user manager are not supported; there the
plugin does nothing.

## Configuration

Environment variables, from the environment `claude` was started with. The
confinement ones are read when a session starts, the refusal ones on every
`Bash` call and, for the pressure line, on every prompt and session start.
Values are integers; a trailing `%` is accepted. An invalid or
out-of-range value falls back to the default.

| Variable | Default | Sets |
|---|---|---|
| `LOADGUARD_MEMORY_HIGH` | `30` | `MemoryHigh`, % of `MemTotal` — above this the session is throttled |
| `LOADGUARD_MEMORY_MAX` | `40` | `MemoryMax`, % of `MemTotal` — above this the kernel kills inside the scope |
| `LOADGUARD_MEMORY_SWAP_MAX` | `10` | `MemorySwapMax`, % of `MemTotal` (`0` allowed) |
| `LOADGUARD_CPU_WEIGHT` | `50` | `CPUWeight`, 1–10000 (systemd default: 100) |
| `LOADGUARD_CONFINE` | — | `0` turns confinement off |
| `LOADGUARD_PSI_FULL` | `10` | refuse heavy commands at this memory PSI `full avg10`, 1–100 % |
| `LOADGUARD_SWAP_USED` | `90` | … or at this much of all swap used, 1–100 % |
| `LOADGUARD_HEAVY_SLOTS` | `nproc/2`, at least 1 | heavy commands allowed at once across all confined sessions |
| `LOADGUARD_THROTTLE` | — | `0` turns refusing and the pressure line off |

The limit is per session, and `claude` itself (about 300 MB) counts against
it. To see where a session landed:

```sh
systemctl --user list-units 'loadguard-*'
```

## CLI

The plugin's `bin/` is on the `PATH` of Claude Code's Bash tool while the
plugin is enabled, so the model can ask loadguard itself — and so can you,
from a session or with the full path
(`~/.claude/plugins/cache/<marketplace>/loadguard/<version>/bin/loadguard`).

| Command | Answers |
|---|---|
| `loadguard status` | memory pressure, swap, zram, the limits in effect, heavy slots busy and who holds them, whether this session is confined |
| `loadguard explain '<command>'` | what the hook would do with this Bash command right now — a dry run, nothing is executed |
| `loadguard doctor` | whether loadguard can work on this host; exits 1 if something that should work does not |

```
$ loadguard status
memory:  PSI full 0.00% (limit 10%), some 0.31%; swap 60% used (limit 90%); zram 97% full
slots:   1/2 heavy busy
         prove -lr t/ in ~/dev/sunriser
heavy:   a heavy command would run now
session: confined in loadguard-7085681a-2882634.scope
hook:    /home/you/.claude/plugins/data/loadguard-getty/bin/loadguard-hook (installed as loadguard@getty)

$ loadguard explain 'dzil test'
heavy:   yes (dzil test)
memory:  PSI full 0.00% (limit 10%), some 0.31%; swap 60% used (limit 90%); zram 97% full
slots:   2/2 heavy busy
         prove -lr t/ in ~/dev/sunriser
         make test in ~/dev/p5-foo
verdict: deny; the model is told:
         loadguard: heavy command refused (dzil test): 2/2 heavy slots busy (prove -lr t/ in ~/dev/sunriser; make test in ~/dev/p5-foo), memory pressure full=0.0% (limit 10%), swap 60% used (limit 90%), zram 97% full.
         Wait for one to finish, then retry; light commands (git status, ls, cat) still run. When you retry, run a single test file instead of the whole suite.
```

The answers come from the hook binary itself, through two read-only report
modes, so the CLI and the hook cannot disagree. The limits are read from the
CLI's own environment — the session's, when the model runs it. Under memory
pressure `status` does not look at running processes, just as the hook does
not: reading them can stall on swap. Without a hook binary (not built yet, no
compiler) `status` and `explain` say that the hook is passing everything
through; `doctor` says how to build it. The CLI itself never builds or
refuses anything.

## Install

Via the shared marketplace that carries every Getty plugin:

```sh
claude plugin marketplace add Getty/marketplace
claude plugin install loadguard@getty
```

Or from inside Claude Code: `/plugin marketplace add Getty/marketplace`, then
`/plugin install loadguard@getty`. New sessions are confined from then on.
The first session start builds the hook in the background, which takes a few
seconds; until it exists nothing is refused. `loadguard doctor`, run from a
new session, shows whether everything is in place.

To update, run `claude plugin update loadguard@getty` and start a new
session. If the hook's sources changed, it rebuilds on that session start.

## Turning it off

- **Confinement only:** start `claude` with `LOADGUARD_CONFINE=0` in its
  environment. Only the exact value `0` switches it off; anything else keeps
  the default.
- **Refusing and the pressure line:** start `claude` with
  `LOADGUARD_THROTTLE=0`, same rule.
- **The whole plugin:** `claude plugin disable loadguard@getty`, or
  `claude plugin uninstall loadguard@getty`.

Each takes effect for new sessions. A session that is already confined stays
in its scope until it ends.

## Codex

The same plugin works under [Codex](https://github.com/openai/codex) (checked
against the 0.153.4 sources): one `hooks/hooks.json` serves both, and Codex
fires the same three events. Each Codex session is confined like a Claude
Code session — the `codex` process goes into its own scope — and the shell
commands the model runs are refused under the same rules, with the same
reason, whether they come from Claude Code or from Codex. A `codex exec` is
heavy like `claude -p`. Codex's own sandbox (`codex-linux-sandbox` and
`bwrap`) stays inside the scope and does not change how commands are
counted.

**The Codex marketplace entry is not published yet.** Once it is:

```sh
codex plugin marketplace add Getty/marketplace
codex plugin add loadguard@getty
```

Codex asks you to trust a plugin's hooks before it runs them — each of the
five, and again whenever `hooks/hooks.json` changes. Until you do, loadguard
is installed but silent: nothing is confined, nothing refused, no error.
Non-interactive runs (`codex exec`) cannot grant that trust; start `codex`
once and accept the prompt. To update, run `codex plugin add loadguard@getty`
again; to remove it, `codex plugin remove loadguard@getty`. The environment
variables under [Configuration](#configuration) apply unchanged, read from
the environment `codex` was started with.

Differences from Claude Code:

- **One scope per Codex process.** `codex` and `codex exec` run one session
  per process. A shared app-server — the local daemon behind
  `codex remote-control`, which a new `codex` connects to when it is running,
  or the `codex app-server` behind the VS Code extension — hosts many
  sessions in one process. The first of them confines it; the others share
  that scope and its limit, as a nested `claude -p` shares its parent's.
- **The CLI is not on the model's `PATH`.** Codex does not add a plugin's
  `bin/` to its shell. Run it by its full path from a terminal:
  `~/.codex/plugins/cache/getty/loadguard/<version>/bin/loadguard status`.
  Inside Codex's sandbox `/proc` shows only the sandbox's own processes, so
  `status` there would miss the heavy commands of other sessions.
- A refused command reaches the model as
  `Command blocked by PreToolUse hook: <reason>. Command: <command>` —
  Codex's wrapping around the same reason.

## Develop

```sh
python3 -m unittest discover -s t -v   # tests
make                                   # build the hook locally into build/
```

Hook path in C with vendored [cJSON](https://github.com/DaveGamble/cJSON);
everything else is Python 3, standard library only. The tests run on recorded
snapshots and payloads — never by putting real load on the machine.

## License

Copyright (c) 2026 Torsten Raudssus.

This is free software; you can redistribute it and/or modify it under the
terms of the [Artistic License 2.0](LICENSE).
