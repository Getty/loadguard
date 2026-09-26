# loadguard

> **The model can't feel the box swapping. The kernel can.**

`loadguard` is a Claude Code plugin that keeps AI-issued shell commands from
taking down the host they run on. Each Claude Code session runs inside its own
systemd scope with memory and CPU limits, so one runaway command hits a wall
inside that session instead of dragging the whole machine into swap.

Linux only. Stage 1 of the design is built; the parts that refuse commands
under pressure and tell the model why are not yet — see [Status](#status).

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
  snapshot, up to 84 %. In the calm ones it stayed at 2 % or below; there was
  nothing in between.
- **Load average up to 85** on 4 cores, most of it tasks stuck waiting for
  pages to come back from swap.
- **One command was enough.** In one snapshot a single `perl -e` one-liner
  held 3.8 GB resident — 48 % of RAM. Not a test suite, not a build: a
  harmless-looking one-liner.

That last point shapes the design. Recognising "heavy" commands by pattern is
not enough; the limit has to cover every command an agent runs. A pattern can
only decide how strict to be.

## How it works

On `SessionStart`, loadguard moves the `claude` process into a transient
systemd user scope:

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
  `SessionStart`. It currently lets every command through unchanged; it is
  in place so the next stages add decisions, not plumbing. Until the binary
  exists (still building, no compiler, build failed) the hook exits 0.

Not built yet:

- **A global limit on heavy commands** across all sessions (`prove`,
  `make test`, `cargo build`, container builds, `claude -p`, …).
- **Refusing heavy commands under memory pressure**, with a short reason the
  model can act on: the pressure figures, what holds the slots, and a lighter
  alternative. Light commands (`git status`, `ls`, `cat`) are never refused.
- **A CLI**: `loadguard status`, `doctor`, `explain '<cmd>'`.

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
- **Python 3** for the `SessionStart` hooks. Standard library only.
- **A C compiler** (`$CC`, else `cc` or `gcc`) for the first build of the hook.
  It builds in the background into the plugin's data directory and rebuilds
  when its sources change. Without a compiler the hook stays a pass-through.

macOS and containers without a user manager are not supported; there the
plugin does nothing.

## Configuration

Environment variables, read when a session starts. Memory values are percent
of `MemTotal`; a trailing `%` is accepted. An invalid or out-of-range value
falls back to the default.

| Variable | Default | Sets |
|---|---|---|
| `LOADGUARD_MEMORY_HIGH` | `30` | `MemoryHigh` — above this the session is throttled |
| `LOADGUARD_MEMORY_MAX` | `40` | `MemoryMax` — above this the kernel kills inside the scope |
| `LOADGUARD_MEMORY_SWAP_MAX` | `10` | `MemorySwapMax` (`0` allowed) |
| `LOADGUARD_CPU_WEIGHT` | `50` | `CPUWeight`, 1–10000 (systemd default: 100) |
| `LOADGUARD_CONFINE` | — | `0` turns confinement off |

The limit is per session, and `claude` itself (about 300 MB) counts against
it. To see where a session landed:

```sh
systemctl --user list-units 'loadguard-*'
```

## Install

Via the shared marketplace that carries every Getty plugin:

```sh
claude plugin marketplace add Getty/marketplace
claude plugin install loadguard@getty
```

Or from inside Claude Code: `/plugin marketplace add Getty/marketplace`, then
`/plugin install loadguard@getty`. New sessions are confined from then on.

## Turning it off

- **Confinement only:** start `claude` with `LOADGUARD_CONFINE=0` in its
  environment. Only the exact value `0` switches it off; anything else keeps
  the default.
- **The whole plugin:** `claude plugin disable loadguard@getty`, or
  `claude plugin uninstall loadguard@getty`.

Either takes effect for new sessions. A session that is already confined stays
in its scope until it ends.

## Codex

Not supported yet; whether and how loadguard can work under Codex is being
looked into.

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
