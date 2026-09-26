# loadguard — Design

Claude-Code-Plugin (Getty-Marketplace), das die Last, die KI-Prozesse auf dem Host
erzeugen, **misst, begrenzt und an die KI zurückmeldet**, damit sie selbst
gegensteuern kann. Ziel-Host zuerst: `reuben` (4 Cores, ~8 GB RAM; Swap = 3,2 GB zram0 + 8 GB `/swapfile`).

## Problem, belegt

`~/load-incidents/*.txt` (54 Snapshots von `~/bin/load-watchdog.sh`, ausgelöst ab
loadavg ≥ 20). Muster vor den Power-Knopf-Reboots:

- RAM voll, **Swap (zram + Swapfile) 100 % voll**, Memory-/IO-PSI `full` > 50 %, Load bis 85.
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
`allow`.

**Freigaben werden am umgeschriebenen Befehl geprüft** (k3, live, korrigiert den
k7-Schluss): Mit nur dem Original in `--allowedTools` wurde der eingewickelte Befehl
verweigert, mit nur den eingewickelten Strings lief alles. k7 sah das Gegenteil nur,
weil der Rewrite dort `echo …` war, das Claude Code als read-only ohnehin freigibt.
Ein Rewrite bricht also die Freigaben des Users — Stufe 1 per `updatedInput` ist in
dieser Form nicht tragfähig (Optionen: Karte k3).

### Stufe 1 — Einsperren: die ganze Session (entschieden 2026-09-26)

Ursprünglich geplant war, jeden Befehl per `updatedInput` in
`systemd-run --user --scope … -- bash -c '<original>'` zu wickeln. k3 hat live gezeigt,
dass das nicht tragfähig ist: Freigaben werden am umgeschriebenen Befehl geprüft
(jede `Bash(git:*)`-Regel bricht), und Claude Code führt jeden Aufruf als
`bash -c 'source <snapshot> && eval <cmd> && pwd -P >| <cwd-datei>'` aus — eine
Kind-Shell im Scope verliert `cd` und die Snapshot-Funktionen.

Stattdessen: **Der SessionStart-Hook schiebt den `claude`-Prozess selbst in einen
transienten systemd-User-Scope mit Limits** (D-Bus `StartTransientUnit` mit `PIDs=`).
Alles, was die Session startet — Bash-Befehle, Subagenten, MCP-Server — erbt den
Scope. Befehle werden nie umgeschrieben: Freigaben, `cd`, Funktionen, Exit-Codes und
`run_in_background` bleiben unberührt; pro Bash-Aufruf kostet Stufe 1 nichts.

Auf reuben verifiziert: Memory-Controller ist an `user@1000.service` delegiert
(`cpu memory pids`, nicht `io`), `memory.max` greift (OOM im Scope → rc 137), eine
fremde PID lässt sich aus der logind-`session-N.scope` in einen eigenen Scope
verschieben (asynchron, ~1–21 ms).

Abwägungen, bewusst in Kauf genommen:
- Das Limit gilt pro Session, nicht pro Befehl; `claude` selbst (~300 MB) zählt mit.
- Bei `MemoryMax` wählt der Kernel im Scope den größten Prozess — in der Regel den
  Ausreißer, nicht `claude`.
- `claude` verlässt die logind-Session-Scope.
- Global über alle Sessions begrenzt erst Stufe 2/3.

Fallback ohne systemd/Delegation (macOS, Container): Stufe 1 aus, fail-open.
Ebenso ohne Linger (`/var/lib/systemd/linger/$USER`): sonst stürbe ein `claude` in
`screen`/`tmux` beim letzten Logout mit dem User-Manager. Ausschalter:
`LOADGUARD_CONFINE=0`. Verschachtelte `claude -p` bleiben bewusst im Scope der
Eltern-Session und teilen deren Limit (entschieden 2026-09-26).

Umgesetzt (k3, `hooks/loadguard-confine`, `lib/loadguard/confine.py`):

- **Eigener async SessionStart-Hook**, Python. Einmal pro Session ist ein
  Subprozess billig: `busctl --user call … StartTransientUnit` (kommt mit systemd;
  kein nachgebautes D-Bus-Protokoll). Live: Call 10 ms, Umzug nach ~30 ms
  bestätigt (`/proc/<pid>/cgroup`, max. 1 s gepollt). Async genügt: Prozesse, die
  claude vor dem Attach gestartet hat (MCP-Server, ein früher Befehl), werden als
  Nachkommen mitverschoben; in beiden Live-Sessions war der Hook vor dem ersten
  Bash fertig.
- **Welcher Prozess:** der nächste Vorfahr des Hooks mit `comm` oder `argv[0]`
  `claude` (höchstens 8 Ebenen), aus `/proc` gelesen.
- **Eine Regel für Idempotenz und Verschachtelung:** Liegt dieser claude schon in
  irgendeinem `loadguard-*.scope`, passiert nichts. resume/clear/compact sind damit
  No-ops, und ein `claude -p` aus einer eingesperrten Session bleibt im Scope der
  Eltern — herausholen hieße, dem Limit zu entkommen.
- **Name `loadguard-<session_id[:8]>-<pid>.scope`** in **`app-loadguard.slice`**:
  `app.slice` ist der Ort für Anwendungen im User-Manager; die eigene Slice gibt
  Stufe 2/3 einen Knoten für ein gemeinsames Limit aller Sessions. Die PID macht
  den Namen eindeutig, auch wenn zwei Prozesse dieselbe Session fortsetzen.
- **`OOMPolicy=continue` ist Pflicht:** Default ist `stop` — ein OOM-Kill des
  Ausreißers würde den ganzen Scope und damit claude beenden. `CollectMode=
  inactive-or-failed`: der Scope verschwindet mit dem letzten Prozess.
- **Limits** in % von MemTotal, per Env: `LOADGUARD_MEMORY_HIGH` 30,
  `LOADGUARD_MEMORY_MAX` 40, `LOADGUARD_MEMORY_SWAP_MAX` 10, `LOADGUARD_CPU_WEIGHT`
  50 (systemd-Default 100). Auf reuben: High 2,3 GiB, Max 3,1 GiB, Swap 0,8 GiB.
  Der 3,8-GB-Perl-Einzeiler (20260917-175030) passt samt claude nicht hinein
  (Max + Swap < 3,8 GB + 0,3 GB) und wird im Scope OOM-gekillt; ab 2,3 GiB wird
  die Session gebremst, ein normaler Build bleibt darunter. `IOWeight` fehlt: `io`
  ist nicht delegiert.
- **Delegation** einmal pro Boot: `memory` in `user@UID.service/cgroup.controllers`,
  gecacht als `<boot_id> yes|no` in `$XDG_RUNTIME_DIR/loadguard/delegation`.
- **Bekannt:** cgroup v2 zieht Speicherladungen beim Umzug nicht mit — was claude
  vor dem Attach allokiert hat, bleibt der logind-Scope angerechnet. Ohne Linger
  endet `user@UID.service` mit der letzten Login-Session und nimmt die Scopes mit
  (reuben: `Linger=yes`).

### Stufe 2 — Global begrenzen (schwere Befehle)

Über **alle** Claude-Sessions des Users hinweg laufen höchstens N schwere Befehle
gleichzeitig (Default: `max(1, nproc/2)`). **Gezählt per `/proc`-Scan** (entschieden
2026-09-26): Der PreToolUse-Hook zählt laufende schwere Prozesse unter
`app-loadguard.slice`. `flock`-Slots gehen nicht, weil der Hook endet, bevor der Befehl
startet, und Befehle nicht umgeschrieben werden (k3). Keine Locks, nichts bleibt
hängen; akzeptiertes Rennen: zwei Sessions, die im selben Moment starten, sehen beide
einen freien Slot. Schwer = Muster (`prove`, `dzil test|build|release`,
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
- Keine Kontrolle über Prozesse außerhalb von Claude-Code-Sessions (podman-Runs
  anderer Tools). perlbench-Container brauchen eigene `--memory`-Limits
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
  über **vendored cJSON** (`vendor/cJSON/`, v1.7.19, MIT) — kein handgebautes Parsen, keine
  `-dev`-Pakete auf dem Zielhost, nur ein C-Compiler.
- **CLI (`status`/`doctor`/`explain`) und Tests bleiben Python** (stdlib). `explain`
  ruft das Binary, damit die Entscheidungslogik genau einmal existiert.
  `lib/loadguard/snapshot.py` (k2) bleibt für CLI und Tests.
- **Build beim ersten Lauf** auf dem Zielhost. Solange kein Binary da ist (kein
  Compiler, Build läuft noch, Build fehlgeschlagen): **fail-open Pass-through**.
  Der Build darf nie einen Bash-Aufruf blockieren.

Umgesetzt (k8):

- **Build-Ort `${CLAUDE_PLUGIN_DATA}/bin/loadguard-hook`** — laut
  plugins-reference `~/.claude/plugins/data/<id>/`, bleibt über Plugin-Updates
  erhalten; `${CLAUDE_PLUGIN_ROOT}` wechselt mit jeder Version. Veraltet heißt:
  der Stempel neben dem Binary (SHA-256 über Quellen, Flags, Compiler-Pfad/-Größe/
  -mtime) passt nicht mehr — ein Update mit geänderten Quellen baut neu, bloß
  kopierte Dateien mit neuer mtime nicht.
- **SessionStart** (`hooks/loadguard-build`, `async`) forkt ein abgelöstes Kind
  (eigene Session, stdio auf `/dev/null`, `nice 10`), das unter `flock` atomar baut
  (temp + rename, 120 s Timeout). Ohne Compiler nichts; Build fehlgeschlagen →
  altes Binary weg → Pass-through. Abgelöst, weil `claude -p` async-Hooks beim
  Beenden killt — sonst würde bei reinen Headless-Sessions nie fertig gebaut.
- **PreToolUse** startet den sh-Starter `hooks/loadguard` in Exec-Form
  (`args: ["${CLAUDE_PLUGIN_DATA}"]`): Binary da → `exec`, sonst `exit 0`. Das
  Binary direkt einzutragen spart ~2 ms, gäbe aber bis zum ersten Build (und
  ohne Compiler für immer) bei jedem Bash-Aufruf eine sichtbare
  Hook-Fehlermeldung (exit 127).
- **Der Python-Hook ist gelöscht**: ohne Binary ist Pass-through genau
  `exit 0`, dafür braucht es keinen Interpreter für 83–183 ms.
