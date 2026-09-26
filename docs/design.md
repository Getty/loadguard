# loadguard — Design

Claude-Code-Plugin (Getty-Marketplace), das die Last, die KI-Prozesse auf dem Host
erzeugen, **misst, begrenzt und an die KI zurückmeldet**, damit sie selbst
gegensteuern kann. Ziel-Host zuerst: `reuben` (4 Cores, ~8 GB RAM; Swap = 3,2 GB zram0 + 8 GB `/swapfile`).

## Problem, belegt

`~/load-incidents/*.txt` (54 Snapshots von `~/bin/load-watchdog.sh`, ausgelöst ab
loadavg ≥ 20). Muster vor den Power-Knopf-Reboots:

- RAM voll, **Swap (zram + Swapfile) 100 % voll**, Memory-/IO-PSI `full` > 50 %, Load bis 45.
- 5–7 parallele `claude`-Sessions, jede im D-State (`folio_wait_bit_common`).
- **Ein einzelner Befehl frisst alles**: `20260917-175030.txt` zeigt ein
  `perl -Ilib -MJSON::Schema::Modern -e …` mit **3,8 GB RSS (48 % RAM)** — ein
  harmlos aussehender Einzeiler, kein `prove`, kein `make`.
- Headless-Agenten in podman (`perlbench`) laufen `prove -lr t/` in Dauerschleife.

Die zentrale Lehre aus dem 3,8-GB-Einzeiler: **Muster-Erkennung „schwerer Befehle"
allein reicht nicht.** Der Schutz muss für *jeden* KI-Bash-Befehl gelten; das Muster
entscheidet nur über die Strenge.

## Mechanismus

Ein `PreToolUse`-Hook mit Matcher `Bash`. Er bekommt den Befehl als JSON auf stdin
und darf ihn (a) durchlassen, (b) umschreiben (`updatedInput`) oder (c) verweigern
(`permissionDecision: deny` + Grund — dieser Grund landet bei der KI und ist der
Kanal, über den sie gegensteuert).

**`updatedInput` ersetzt `tool_input` vollständig** (festgenagelt 2026-09-26, k7,
Claude Code 2.1.283, `t/fixtures/updated-input/`): Felder, die der Hook weglässt
(`description`, `timeout`), fehlen danach im ausgeführten `tool_input`. Der Hook muss
also das eingehende `tool_input` komplett kopieren und nur `command` tauschen. Das
eingehende `tool_input` enthält nur, was die KI gesetzt hat — keine Defaults.
`updatedInput` wirkt ohne `permissionDecision`; loadguard sendet beim Umschreiben kein
`allow`. Der umgeschriebene Befehl lief, obwohl nur der Originalbefehl per
`--allowedTools` freigegeben war — Freigaben wurden am Originalbefehl geprüft (oder
nach dem Umschreiben nicht erneut); die Umverpackung in `systemd-run` sollte User-
Freigaben also nicht brechen. Ungetestet: ein nicht freigegebenes Original.

### Stufe 1 — Einsperren (immer)

Jeder Bash-Befehl wird in einen transienten systemd-User-Scope gewickelt:

```sh
systemd-run --user --scope -q \
  -p MemoryHigh=<hi> -p MemoryMax=<max> -p MemorySwapMax=<swap> \
  -p CPUWeight=<w> -p IOWeight=<w> -- sh -c '<original>'
```

Auf reuben verifiziert: Memory-Controller ist an `user@1000.service` delegiert
(`cpu memory pids`), `memory.max` greift. Wirkung: Ein ausufernder Befehl wird
gebremst (`MemoryHigh`) bzw. vom Kernel im eigenen Scope gekillt (`MemoryMax`),
statt zram zu fluten und die Kiste zu thrashen. Die KI sieht dann einen Exit
137/OOM — und einen Hinweis von loadguard, was passiert ist (PostToolUse).

Offene Fragen, vor dem Bauen zu klären:
- Quoting: den Originalbefehl robust in `sh -c` übergeben (keine Shell-Injection
  durch die Umverpackung, Heredocs, `cd`-Semantik der Bash-Tool-Session erhalten).
- Verträgt sich der Scope mit `run_in_background` und mit der persistenten
  Arbeitsverzeichnis-Semantik des Bash-Tools?
- Fallback ohne systemd/cgroup-Delegation (macOS, Container): `nice`/`ionice` +
  `ulimit -v`, oder Stufe 1 aus.

### Stufe 2 — Global begrenzen (schwere Befehle)

Über **alle** Claude-Sessions des Users hinweg laufen höchstens N schwere Befehle
gleichzeitig (Default: `max(1, nproc/2)`). Slots als `flock`-Dateien unter
`$XDG_RUNTIME_DIR/loadguard/`. Schwer = Muster (`prove`, `dzil test|build|release`,
`make test`, `cpanm`, `docker|podman build|run`, `cargo build|test`, `npm test`,
`perlbench`, `claude --bg`, `claude -p`) **plus** alles, was nachträglich im
Scope viel Speicher gezogen hat (Lernliste, später).

Kein freier Slot → Stufe 3 statt stillem Warten (die KI soll wissen, dass sie wartet).

### Speichersignal (entschieden 2026-09-26)

Aus den 54 Snapshots (k2): **memory PSI `full avg10`** trennt scharf — < 2 % in der
CPU-lastigen Phase, > 45 % in jedem Thrash-Snapshot, nichts dazwischen. `avg10`, nicht
`avg60/300`: der Thrash kommt schlagartig (175030: avg10 63 %, avg300 20 %).
Nebensignal: **Swap gesamt** (`SwapFree/SwapTotal` aus `/proc/meminfo`) — 100 % belegt
in jedem Thrash-Snapshot, nie in der ruhigen Phase. **zram-Füllgrad allein ist kein
Signal**: zram0 steht schon im Ruhezustand bei ~98 %, das Swapfile nimmt den Überlauf;
er erscheint nur als Info in der Begründung. `MemAvailable` ist schwach (1,1–1,7 GB
auch im Thrash). `cpu some` ist auf reuben routinemäßig hoch und kein Notfall.

### Stufe 3 — Ablehnen mit Begründung

Bei Druck oberhalb der Schwelle (PSI memory `some avg10`, `full avg10`,
zram-Füllgrad, freie Slots) wird ein schwerer Befehl verweigert. Die Begründung ist
das Produkt — kurz, messbar, mit konkreter Alternative:

> loadguard: memory pressure full=38% (limit 20%), swap 97%, 2/2 heavy slots busy
> (prove -lr t/ in ~/dev/sunriser, perlbench). Warte, oder teste gezielt
> (`prove -l t/foo.t` statt `-r`). Keine neuen `claude --bg` starten.

Leichte Befehle (`git status`, `karr show`, `ls`, `cat` …) werden nie verweigert —
sonst kann die KI nicht einmal nachsehen, was los ist.

### Stufe 4 — Lagebewusstsein (optional)

`UserPromptSubmit`/`SessionStart`: nur wenn die Last erhöht ist, eine Zeile Status in
den Kontext. Im Normalzustand kostet loadguard **null** Kontext-Tokens.

### CLI

`bin/loadguard` (auch als Hook-Einstieg): `status` (PSI, Slots, wer hält sie),
`doctor` (cgroup-Delegation, systemd-run, Schwellwerte), `explain '<cmd>'`
(wie würde der Hook entscheiden).

## Nicht-Ziele

- Kein Ersatz für `earlyoom` (läuft auf reuben) — loadguard verhindert, dass es so
  weit kommt; earlyoom bleibt die letzte Leitplanke.
- Keine Kontrolle über Prozesse, die nicht durch das Bash-Tool gehen (podman-Runs
  anderer Tools, MCP-Server). perlbench-Container brauchen eigene `--memory`-Limits
  — separates Ticket, kein Hook-Thema.
- Kein Telemetrie-Versand. Alles lokal.

## Kalibrierung

Schwellwerte gegen `~/load-incidents` ableiten: Welche PSI-Werte standen in den
Snapshots *vor* dem Kipp-Punkt? Konfigurierbar per Env/Config-Datei, Defaults
konservativ für 8 GB / 4 Cores.

## Lieferung

Eigenes Repo, später Eintrag in `~/dev/marketplace` (`Getty/marketplace`), analog
`briefing`. Hook-Laufzeit im Normalfall < 30 ms (er läuft vor **jedem** Bash-Aufruf
aller Sessions).

### Sprache und Build (entschieden 2026-09-26)

Gemessen (k1): Ein Python-Hook kostet auf reuben im Median 183 ms, p90 346 ms — fast
nur Interpreter-Start. Daher:

- **Hook-Pfad in C** (Payload lesen, `/proc` messen, einwickeln, entscheiden). JSON
  über **vendored cJSON** (`vendor/cJSON.{c,h}`, MIT) — kein handgebautes Parsen, keine
  `-dev`-Pakete auf dem Zielhost, nur ein C-Compiler.
- **CLI (`status`/`doctor`/`explain`) und Tests bleiben Python** (stdlib). `explain`
  ruft das Binary, damit die Entscheidungslogik genau einmal existiert.
  `lib/loadguard/snapshot.py` (k2) bleibt für CLI und Tests.
- **Build beim ersten Lauf** auf dem Zielhost. Solange kein Binary da ist (kein
  Compiler, Build läuft noch, Build fehlgeschlagen): **fail-open Pass-through**.
  Der Build darf nie einen Bash-Aufruf blockieren.
