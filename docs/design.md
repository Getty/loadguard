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
transienten systemd-User-Scope mit Limits** (D-Bus `StartTransientUnit` mit `PIDs=`
nur für `claude`; was `claude` vorher gestartet hat, folgt per
`AttachProcessesToUnit`, dafür `Delegate=yes` — k12: eine verschwundene PID in `PIDs=`
lässt die Unit asynchron scheitern, obwohl der Aufruf gelingt).
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

Bei Druck oberhalb der Schwelle (Speichersignal oben) oder ohne freien Slot wird ein
schwerer Befehl verweigert. Die Begründung ist das Produkt — kurz, messbar, mit
konkreter Alternative:

> loadguard: memory pressure full=38% (limit 20%), swap 97%, 2/2 heavy slots busy
> (prove -lr t/ in ~/dev/sunriser, perlbench). Warte, oder teste gezielt
> (`prove -l t/foo.t` statt `-r`). Keine neuen `claude --bg` starten.

Leichte Befehle (`git status`, `karr show`, `ls`, `cat` …) werden nie verweigert —
sonst kann die KI nicht einmal nachsehen, was los ist.

### Umgesetzt (k4): Stufe 2 + 3

`src/loadguard-hook.c`, Tests `t/test_throttle.py`.

- **Eine Regel, im C-Binary:** eingehender Befehl schwer **und** (Speicherdruck
  **oder** alle Slots belegt) → Deny-JSON auf stdout, exit 0. Sonst keine Ausgabe,
  exit 0, wie bisher. Ein leichter Befehl löst keinen einzigen Lesezugriff aus
  (nur stdin); Test: `/proc/pressure/memory` als FIFO blockiert ihn nicht.
- **Schwellwerte**, per Env, ganze Zahlen, `%` erlaubt, ungültig oder außerhalb
  1–100 (Slots 1–4096) → Default:
  `LOADGUARD_PSI_FULL` **10** (memory `full avg10` in %),
  `LOADGUARD_SWAP_USED` **90** (Swap gesamt belegt in %),
  `LOADGUARD_HEAVY_SLOTS` **`max(1, nproc/2)`** (CPUs der Affinität wie `nproc`;
  reuben: 2). `LOADGUARD_THROTTLE=0` — nur genau `0` — schaltet auf reinen
  Pass-through.
- **Herleitung** aus den 54 Snapshots (Parser k2; Test `Calibration` baut jeden als
  `/proc`-Baum nach und prüft die Entscheidung des Binarys):
  ruhig 18× — full avg10 0,00–2,03 %, Swap 50,6–68,3 %;
  Thrash 36× — full avg10 45,47–84,51 %, Swap 91,9–100 %. Ausnahmen beim Swap:
  20260816-204258 (damals noch kein Swap) und 20260917-183232 (direkt nach einem
  Kill: 20 % belegt, 5 GB frei, PSI noch 62,9).
  PSI 10 liegt nahe dem geometrischen Mittel der Lücke (√(2,03 · 45,47) ≈ 9,6):
  fünfmal über dem ruhigen Höchstwert, 4,5-mal unter dem kleinsten Thrash. Swap 90
  liegt zwischen 68,3 und 91,9. Verknüpft mit **ODER**: PSI allein verweigert schon
  jeden Thrash-Snapshot, Swap allein 34 von 36; kein ruhiger Snapshot erreicht eine
  der Schwellen. Swap ≥ 90 % bei niedrigem PSI heißt: nichts mehr auszulagern, der
  nächste große Befehl verdrängt Dateiseiten — der Weg in den Thrash, bevor PSI ihn
  zeigt. zram erscheint nur in der Begründung. Live reuben (2026-09-26): full
  0,01 %, Swap 51 %, zram 98 %, 297 Prozesse → nichts verweigert.
- **Unter Druck kein Prozess-Scan.** `/proc/<pid>/cmdline` liest die
  Argumentseiten des fremden Prozesses — im Thrash ausgelagert, der Leser wartet auf
  Swap-IO. Ein Hook-Timeout blockiert den Befehl laut Docs **nicht**: Ein langsamer
  Scan ließe genau den schweren Befehl durch. Der Druck-Grund nennt deshalb nur die
  Messwerte, keine Slot-Halter. Test: eine cmdline als FIFO würde jeden Leser
  blockieren, die Druck-Entscheidung kommt trotzdem sofort.
- **Slot-Scan** (nur ohne Druck): ein Durchlauf über `/proc`; `cgroup` enthält
  `/app-loadguard.slice/` → `stat` (ppid hinter der letzten `)` — comm kann
  Leerzeichen und Klammern enthalten, npm: `npm exec claude`) und `cmdline`.
  Beurteilt wird argv, nicht Text: Basename von argv[0]; bei Interpretern (`perl`,
  `python3`, `node`, `sh`, `bash` …) das Skript — der Kernel startet prove als
  `/usr/bin/perl /usr/bin/prove -lr t/`. Inline-Code (`-c`, `-e`, `-E`) ist kein
  Skript: Der Claude-Code-Wrapper `bash -c '… eval …'` zählt nie, auch wenn sein
  Format sich ändert. Ein Prozesstitel (npm schreibt `npm test`, mit NULs
  aufgefüllt) wird an Leerzeichen getrennt. Es zählt nur der **oberste** schwere
  Prozess einer Kette innerhalb der Slice: prove mit perl-Kindern, rekursives
  `make test`, `npm test` → prove sind je ein Slot. `claude -p`/`--bg` halten
  keinen Slot; was sie starten, zählt einzeln.
- **Schwer (eingehend):** der String wird in einfache Befehle zerlegt (`;` `&` `|`
  `(` `)` `` ` `` Zeilenumbruch) unter Beachtung von Quotes, Backslashes,
  Kommentaren, Umleitungen und Heredoc-Rümpfen. Vor dem Befehlswort übersprungen:
  `VAR=x`, `nice` `ionice` `nohup` `timeout` `env` `stdbuf` `setsid` `xargs`
  `time` `exec` samt Optionen und Zahlen, `if` `then` `do` `!` `{` … Muster wie
  oben, dazu `claude --print` (= `-p`). Kein Shell-Parser: Unklares fällt auf
  leicht (`bash -c 'prove …'`, `sudo prove`, `find -exec prove`, mehr als 32
  Wörter vor `test`) — die Session-Grenze aus Stufe 1 gilt trotzdem.
- **Begründung** englisch, zwei Zeilen — Zahlen, dann Rat:

  > loadguard: heavy command refused (dzil test): 2/2 heavy slots busy (prove -lr
  > t/ in ~/dev/sunriser; make test in ~/dev/p5-foo), memory pressure full=0.0%
  > (limit 10%), swap 60% used (limit 90%), zram 97% full.
  > Wait for one to finish, then retry; light commands (git status, ls, cat) still
  > run. Or run a single test file instead of the whole suite.

  Unter Druck: `…: memory pressure full=59.9% (limit 10%), swap 100% used (limit
  90%). Wait and retry later; …`. Rat je Muster: prove → `prove -l t/foo.t` statt
  `-r`; Testsuite → eine Testdatei; `claude -p`/`--bg` → keine neuen Sessions.
  Höchstens drei Halter, dann `+N more`; Pfade mit `~`, Steuerzeichen und
  ungültiges UTF-8 als `?`.
- **Kosten** (reuben, 297 Prozesse, je 300 Läufe inkl. Prozessstart, `nice`):
  leicht 0,53 ms Median (`/bin/true`: 0,50), schwer und ruhig mit vollem Scan
  3,64 ms (p90 4,44), schwer unter Druck 0,62 ms. Ziel < 30 ms.
- **Fail-open:** keine PSI-Datei, kein Swap, unlesbares `/proc` → dieses Signal
  meldet keinen Druck; ein Prozess, der zwischen `readdir` und dem Lesen
  verschwindet, zählt nicht. Nie exit 2, SIGPIPE ignoriert. Ausgabe ohne
  abschließenden Zeilenumbruch — die Form, die k7 live erprobt hat.
- **Testbarkeit:** die Wurzel für `/proc` und `/sys` gibt es nur im Testtreiber
  (`-DLOADGUARD_TEST`: `decide ROOT`, `slots ROOT`, `measure ROOT`, `heavy`); das
  Produktions-Binary liest immer das echte `/proc`. Laufende Prozesse kommen als
  JSON-Specs aus `t/fixtures/procs/`. **Für k5:** ein synthetischer Payload auf
  stdin des Produktions-Binarys liefert die Live-Entscheidung — Deny-JSON oder
  nichts; *warum* etwas durchgeht, gibt das Binary nicht aus (k5: dafür gibt
  es jetzt `--explain`).
- **Rennen, akzeptiert:** zwei Sessions im selben Moment sehen beide einen freien
  Slot; ebenso ein Befehl, dessen schwerer Prozess noch nicht läuft.

### Stufe 4 — Lagebewusstsein (optional)

`UserPromptSubmit`/`SessionStart`: nur wenn die Last erhöht ist, eine Zeile Status in
den Kontext. Im Normalzustand kostet loadguard **null** Kontext-Tokens.

### CLI

`bin/loadguard`: `status` (PSI, Slots, wer hält sie), `doctor`
(cgroup-Delegation, busctl, Schwellwerte), `explain '<cmd>'` (wie würde der
Hook entscheiden). Hook-Einstieg ist seit k8 `hooks/loadguard`.

Umgesetzt (k5, `bin/loadguard`, `lib/loadguard/cli.py`; Tests
`t/test_cli.py`, `t/test_throttle.py` `Report`):

- **Die Entscheidung existiert einmal, im C-Binary.** Es hat zwei Report-Modi,
  je eine JSON-Zeile auf stdout, nur lesend: `loadguard-hook --report`
  (Grenzen, memory PSI full/some, Swap, zram, Slots mit Haltern,
  `refuse_heavy`; liest kein stdin) und `loadguard-hook --explain`
  (Hook-Payload auf stdin; `decision`, `reason` wörtlich, dazu was gemessen
  wurde). Beide rufen `objection()` und `no_room()`, die Funktionen des
  Hook-Pfads; ein `struct verdict` hält fest, wie weit sie gekommen sind. Die
  CLI formatiert nur: Sie klassifiziert keinen Befehl, scannt kein `/proc` und
  vergleicht keinen Wert mit einer Grenze. Test `test_explain_is_the_hook`:
  4 Wurzeln × 5 Umgebungen × 8 Befehle, Entscheidung und Grund wie `decide`,
  Byte für Byte.
- **Hook-Modus unverändert:** Jeder Aufruf außer genau `--report` oder
  `--explain` ist der Hook wie bisher; `hooks/loadguard` startet ohne
  Argumente. Gemessen (je 1500 Aufrufe, abwechselnd gegen HEAD, `nice`):
  leicht 0,609 → 0,605 ms, schwer mit Scan 4,002 → 4,003 ms Median.
- **Keine Wurzel im Produktions-Binary:** `report ROOT`/`explain ROOT` gibt es
  nur im Testtreiber; damit sind die Formatierungen auf Fixtures getestet.
- **Ungültige Env-Werte:** Der Report nennt gesetzte Variablen, die nichts
  ändern (`ignored`) — Grenzen, die `env_int` verwirft (dieselbe Prüfung wie
  der Hook), und `LOADGUARD_THROTTLE` ≠ `0`. Die Stufe-1-Variablen prüft
  `doctor` mit `confine.env_int`.
- **`status` unter Druck scannt nicht**, wie der Hook: Die Slot-Zeile sagt,
  dass nichts gelesen wurde und warum (cmdline-Lesen kann auf Swap warten);
  Druck allein verweigert. So bleibt `status` im Thrash schnell. Dazu wartet
  die CLI höchstens 10 s auf das Binary und danach nicht auf dessen Ende — ein
  Leser, der auf Swap wartet, stirbt nicht sofort.
- **Welches Binary:** `$CLAUDE_PLUGIN_DATA`, wenn gesetzt — laut
  plugins-reference bekommen es Hooks, das Bash-Tool nicht. Sonst für eine
  installierte Kopie (`<plugins>/cache/<marketplace>/<plugin>/<version>/`)
  deren Datenverzeichnis `<plugins>/data/<id>`, id `<plugin>@<marketplace>`
  mit allem außer `[A-Za-z0-9_-]` als `-` (reuben: `loadguard-getty`). Im
  Checkout `build/` (make), ohne Build das Datenverzeichnis einer
  `--plugin-dir`-Session (`loadguard@inline` → `loadguard-inline`). Kein Glob
  `loadguard-*`: Auf reuben liegen `loadguard-getty` und `loadguard-inline`
  nebeneinander, mit Binarys verschiedener Stände. Ohne Binary sagen
  `status`/`explain` klar: Pass-through, nichts wird verweigert. Ein Binary
  ohne Report-Modus (ältere Quellen) → Hinweis, Exit 1. Die CLI baut nie;
  `doctor` nennt den Befehl.
- **`bin/` liegt auf dem PATH des Bash-Tools**, solange das Plugin aktiv ist
  (plugins-reference, geprüft 2026-09-26): Das Modell kann `loadguard status`
  selbst aufrufen. Ausgabe deshalb kurz, `label: wert`, nur ASCII.
- **`doctor`** prüft Stufe 1 so, wie `confine()` sie sieht (`cgroup`,
  `user_bus`, `find_busctl`, `delegated`, `lingering`, `limits`;
  `user_bus`/`find_busctl`/`disabled` dafür aus `confine()` herausgezogen),
  dazu ob diese Session in einem `loadguard-*.scope` liegt; Stufe 2/3: Binary
  da, aktuell (`build.current`: Stempel gegen die Quellen neben der CLI),
  Compiler, Report-Modus, Grenzen. Exit 1 bei jedem FAIL: Voraussetzung fehlt,
  Binary fehlt/veraltet/ohne Report, Session nicht eingesperrt obwohl es
  ginge, ignorierte Env-Werte. Bewusst ausgeschaltet (`=0`) ist kein Fehler.
  Die Karte nannte `systemd-run` — seit k3 ist es `busctl`.
- **Kosten der CLI** (reuben): `status`/`explain` ~47 ms, `doctor` ~80 ms,
  fast nur Python-Start. Das Binary allein: `--report` ~4 ms mit Scan.

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
