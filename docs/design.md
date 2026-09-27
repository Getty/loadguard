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
  `claude` (höchstens 8 Ebenen; seit k11 auch `codex`), aus `/proc` gelesen.
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
`perlbench`, `claude --bg`, `claude -p`, seit k11 `codex exec`, seit k14
`codex review`) **plus** alles,
was nachträglich im Scope viel Speicher gezogen hat (Lernliste, unten).

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
  > run. When you retry, run a single test file instead of the whole suite.

  Unter Druck: `…: memory pressure full=59.9% (limit 10%), swap 100% used (limit
  90%).` / `Wait and retry later; light commands (git status, ls, cat) still
  run.` Rat je Muster nur bei vollen Slots, und zwar für den nächsten Versuch —
  auch ein kleiner Lauf ist schwer und braucht einen Slot: prove → `When you
  retry, run fewer tests: prove -l t/foo.t instead of -r`; Testsuite → eine
  Testdatei. `claude -p`/`--bg` → keine neuen Sessions, in beiden Fällen.
  **Unter Druck kein Testlauf als Rat** (korrigiert in k6, k4 war
  unveröffentlicht): Jeder Lauf zieht Speicher, ein einzelnes perl kann die
  Maschine nehmen (der 3,8-GB-Einzeiler, 20260917-175030), und `prove -l
  t/foo.t` würde unter Druck ebenso verweigert. Einen Befehl zu nennen, den der
  Klassifizierer durchlässt (`perl -Ilib t/foo.t`), hieße, der KI den Weg um
  den eigenen Wächter zu zeigen. Also: warten, leichte Befehle gehen.
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
- **Live bestätigt** (2026-09-27, `claude -p --plugin-dir` mit Haiku, Claude
  Code 2.1.283): ruhig mit Default-Schwellen bleiben alle fünf Hooks stumm,
  `make test` läuft. Mit `LOADGUARD_HEAVY_SLOTS=1` und einem `make test` aus
  einer anderen Session im Slice verweigert der Hook mit Slot-Grund und nennt
  den fremden Halter; keine Kontextzeile (volle Slots allein zählen nicht).

### Lernliste (entschieden 2026-09-27)

Zweck: vorbeugend für schwere Befehle außerhalb der festen Liste (eigene
Skripte, Build- und Test-Werkzeuge, die dort nicht stehen). **[korrigiert
2026-09-27]** Als Beleg stand hier `/usr/bin/perl t/json_data.t` (3,2–3,4 GB an
drei Tagen, 20260912/-17/-21) als Testdatei „direkt mit `perl`". Falsch: in
allen drei Snapshots ist sein Elternprozess MakeMakers `test_harness`, er lief
unter `make test`, das die feste Liste schon fängt (Befund k15). Keiner der 54
Snapshots zeigt einen Fall, den erst die Lernliste gefangen hätte; der
3,8-GB-Einzeiler kam nur einmal vor, dagegen hilft nur das Scope-Limit
(Stufe 1).

- **Einheit = der exakte Befehlstext** (Getty 2026-09-27: keine Abstraktion,
  „das meiste wird prove oder irgendwas mit nem Container sein"): der String,
  den das Modell als `tool_input.command` schickt, byte-gleich. `cd x && …`
  und `…` sind zwei Befehle. Nicht gelernt wird, was die feste Liste schon
  schwer nennt.
- **Gelernt, wenn** die Prozesse eines Befehls zusammen (RSS-Summe des
  Teilbaums unter seiner Shell) `LOADGUARD_LEARN_RSS` % von `MemTotal`
  erreichen, Default **20** (reuben 1,6 GB), 1–100. RSS, nicht PSS:
  `smaps_rollup` läuft die Seitentabellen ab und kann unter Thrash hängen.
- **Beobachter pro Session** (Getty 2026-09-27: A): das Hook-Binary im Modus
  `--watch`, von `hooks/loadguard-confine` nach dem Einsperren abgelöst
  gestartet (setsid, stdio auf `/dev/null`, `nice`), lebt im Scope der Session.
  Alle 2 s: `cgroup.procs` des Scopes, je PID `/proc/<pid>/stat` und `statm` —
  beides ohne fremde Seiten einzulagern; `cmdline` nur einmal pro neuer
  Shell, die die Schwelle reißt. Ein Beobachter pro Scope (`flock` auf eine
  Datei in `$XDG_RUNTIME_DIR/loadguard/`); ein fortgesetzter oder
  verschachtelter Start im selben Scope endet sofort. Er endet, sobald der
  Session-Prozess weg ist — er darf den Scope nie am Leben halten. Ohne
  Binary (erste Session, Build läuft) kein Beobachter in dieser Session.
  Verworfen: ein gemeinsamer Dienst (Singleton über D-Bus, mehr bewegliche
  Teile); nur in Hook-Läufen mitschauen (ein Vordergrund-Befehl ruft keinen
  Hook, solange er läuft).
- **Welcher Befehl:** vom großen Teilbaum aufwärts die oberste
  `<shell> -c|-lc <string>` unterhalb des Session-Prozesses. Claude Code:
  `/bin/bash -c '… eval '<cmd>' … && pwd -P >| /tmp/claude-XXXX-cwd'` — der
  `eval`-Text, Single-Quote-entschärft (aufgezeichnet: `'"'"'`, nicht
  `'\''` — k15 unten), ist `tool_input.command`
  (live 2026-09-26 für einen einfachen Befehl gesehen; Quotes, Zeilenumbrüche,
  Heredocs, `run_in_background`: aufgezeichnet in k15). Codex: `bash -c|-lc
  <cmd>` hinter der Sandbox-Kette, argv[2] = der Befehl (live bestätigt
  2026-09-27, `t/fixtures/shells/codex.json`). Nicht lesbar oder unbekannte
  Form → nichts gelernt.
- **Sofort schreiben:** beim ersten Reißen der Schwelle, nicht erst am Ende —
  ein Thrash-Reboot mitten im Befehl darf die Lektion nicht verlieren. Danach
  schreibt der Beobachter den Spitzenwert nur neu, wenn er um mindestens 10 %
  gewachsen ist, und einmal, wenn die Shell endet.
- **Ablage:** `${XDG_STATE_HOME:-~/.local/state}/loadguard/learned.jsonl`, eine
  pro Nutzer, geteilt von Claude Code und Codex. Je Zeile ein JSON-Objekt:
  Befehl, Spitzen-RSS, cwd, zuerst und zuletzt groß gesehen. Höchstens 100
  Einträge; darüber fällt der am längsten nicht mehr groß gesehene. Schreiben
  atomar (tmp + rename) unter `flock` — Beobachter und CLI.
- **Im Hook:** exakter Treffer → schwer, wie ein Muster-Treffer (verweigert unter
  Druck oder bei vollen Slots); der Grund sagt, dass er gelernt ist, mit
  Spitzenwert und Datum. Ein laufender gelernter Befehl hält einen Slot: der
  Scan erkennt seine Shell über dieselbe Extraktion (oberster Halter zählt,
  wie bisher). **Invariante geändert** (Getty 2026-09-27): der leichte Pfad
  liest jetzt eine Datei, die Lernliste — ohne Datei ein fehlgeschlagenes
  `open`. Kaputt, zu groß, unlesbar → leer (fail-open).
- **Schalter:** `LOADGUARD_LEARN=0` (nur genau `0`): kein Beobachter, Liste
  ignoriert. `LOADGUARD_THROTTLE=0` schaltet wie bisher alles Verweigern ab.
- **CLI:** `loadguard learned` (Liste mit Nummer, Spitze, zuletzt, cwd, Befehl),
  `loadguard forget <n>` / `--all`; `explain` nennt einen gelernten Treffer;
  `doctor` zeigt Lernen an/aus, Einträge, Beobachter dieser Session.
- **`hooks/hooks.json` bleibt unverändert** — Codex verlangt sonst neuen Trust.
- **Grenzen:** der erste Lauf wird nie gefangen (dafür das Scope-Limit); wer in
  unter 2 s explodiert und im Scope gekillt wird, kann dem Beobachter entgehen;
  eine Session ohne Scope (kein Linger, `LOADGUARD_CONFINE=0`) lernt nicht.
  Unter Codex wird ein einzelner Befehl nicht gelernt (bash `exec`t ihn,
  keine Shell mit dem Text; unten, k15/k14). Ein unter Claude Code gelernter
  Befehl, der später unter Codex als einzelner Befehl läuft, wird beim
  Eintritt verweigert (der Hook vergleicht `tool_input.command`), hält aber
  keinen Slot, solange er läuft: Der Slot-Scan findet gelernte Befehle nur
  über die Shell, die ihren Text trägt, und vergleicht argv nicht mit der
  Liste. Bewusst nicht rekonstruiert (Getty 2026-09-27: der exakte Text,
  kein argv-Nachbau).

### Umgesetzt (k15): Lernliste

`src/loadguard-hook.c` (`--watch`, Liste im Hook und im Slot-Scan),
`lib/loadguard/learn.py`, `hooks/loadguard-confine`, `lib/loadguard/cli.py`;
Tests `t/test_learn.py`, dazu `t/test_cli.py` `Doctor`,
`t/test_hook_passthrough.py` `CodexRuns`/`PluginWiring`; Fixtures
`t/fixtures/shells/claude-code.json`.

- **Wrapper aufgezeichnet** (2026-09-27, Claude Code 2.1.283, zehn eigene
  Bash-Aufrufe; ein Kind las `/proc/<Wrapper>/cmdline`, nur lesend, keine
  Last): `/bin/bash -c 'source <snapshot> 2>/dev/null || true && shopt -u
  extglob 2>/dev/null || true && { \builtin unalias … } >/dev/null 2>&1 ||
  true && eval '<cmd>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd'`. Ein
  `'` im Befehl steht als **`'"'"'`** (Quote zu, `"'"`, Quote auf), nicht
  als `'\''` wie oben angenommen. ` < /dev/null` fehlt, wenn der Befehl
  einen Heredoc oder eine eigene stdin-Umleitung hat. Einfache und doppelte
  Quotes, Heredoc, Zeilenumbruch, Zeilenfortsetzung, `$(…)`, Backslashes,
  UTF-8, `cd x &&`, führende und abschließende Leerzeichen,
  `run_in_background` (dieselbe Form): In allen zehn Fällen liest die
  Extraktion den gesendeten Befehl Byte für Byte zurück.
- **Eine Extraktion** (`shell_command()`) für Beobachter und Slot-Scan:
  `<shell> -c|-lc <string>`, Shell bash, sh, dash oder zsh. Claude Code:
  das Wort nach dem ersten `eval `, gelesen wie die Shell es liest (`'…'`
  wörtlich, `"…"` mit `\"` `\\` `\$` `` \` `` `\<NL>`, `\x`), danach genau
  `[ < /dev/null] && pwd -P >| <pfad>-cwd` bis zum Ende. `$` oder Backtick
  in `"…"`, jedes andere ungequotete Zeichen, ein anderes Ende → unbekannte
  Form. Beide Quote-Schreibweisen lesen sich gleich. Codex: argv[2]
  unverändert. Der Beobachter nimmt die Form des Session-Prozesses (claude →
  nur der Wrapper, codex → nur argv[2]) — so wird unter Claude Code ein
  MCP-Server hinter `sh -c 'context7-mcp'` (so auf reuben) nie gelernt; der
  Slot-Scan kennt den Harness nicht und nimmt den Wrapper, sonst argv[2].
- **Beobachter** `loadguard-hook --watch PID`, PID = der Prozess, für den der
  Scope angelegt wurde (die Zahl im Scope-Namen): Ein verschachteltes
  `claude -p` oder ein weiterer App-Server-Thread fragt nach dem Beobachter,
  der schon läuft. Beim Start: `comm`/argv[0] `claude` oder `codex`,
  `/proc/PID/cgroup` endet in `loadguard-*.scope`, MemTotal lesbar,
  `$XDG_RUNTIME_DIR` gesetzt und `<scope>.watch` darin per `flock` LOCK_NB
  frei (die Datei hält seine PID, für `doctor`) — sonst sofort exit 0.
  `setpriority` 10, `chdir /`, keine Ausgabe. Alle 2 s: Startzeit des
  Session-Prozesses unverändert (sonst Ende, auch bei wiederverwendeter
  PID), `cgroup.procs`, je PID `stat` (ppid, comm, Startzeit) und `statm`.
  Aufruf = oberste Shell (nach `comm`) unter dem Session-Prozess, seine
  RSS = Summe über Shell und alle Nachfahren; Waisen (Eltern nicht im Scope,
  `foo &` nach Ende der Shell) zählen niemandem. `cmdline` genau einmal, wenn
  ein Aufruf die Schwelle reißt; danach gelernt oder als übersprungen
  gemerkt, bis seine Shell endet (höchstens 16 zugleich). Nicht gelernt:
  unbekannte Form, feste Liste, leer, über 4096 Byte, kein UTF-8.
  Geschrieben wird beim Reißen, bei ≥ 10 % mehr, beim Ende der Shell, und
  für alle offenen, wenn der Session-Prozess weg ist. Die Lock-Datei geht
  mit ihm.
- **Liste**: je Zeile `{"command", "peak_rss" (Byte, der höchste je
  gesehene), "cwd", "first_seen", "last_seen" (UTC, ISO 8601)}`. Beobachter
  und `loadguard forget` schreiben unter `flock` auf `learned.lock`: neue
  Datei, `fsync`, `rename`, `fsync` des Verzeichnisses; Modus 0600, das
  Verzeichnis 0700. Über 100 Einträge fällt der mit dem kleinsten
  `last_seen`; kaputte Zeilen fallen beim Schreiben weg, eine zu große Datei
  wird ersetzt.
- **Im Hook**: erst die Muster, dann die Liste (`K_LEARNED`, hält einen
  Slot). Gelesen per `open(O_NONBLOCK)` und `fstat`: nur eine reguläre Datei
  bis 1 MiB, höchstens 256 Zeilen — ein FIFO an ihrer Stelle blockiert den
  leichten Pfad nicht. Grund: `loadguard: heavy command refused (learned:
  peaked at 3.4 GiB RSS on 2026-09-21): memory pressure …` (Datum aus
  `last_seen`, nur `JJJJ-MM-TT` übernommen); Rat wie bei jedem schweren
  Befehl, ohne eigenen Zusatz. Slot-Scan: eine Shell, deren Befehl in der
  Liste steht, ist Halter, benannt nach dem Befehl (auf 48 Byte gekürzt);
  sie liest cmdlines bis 64 KiB, abgeschnitten → kein Treffer; leere Liste →
  keine Extraktion.
- **Start**: `hooks/loadguard-confine` nach `confine()`, nur bei `attached`
  oder `already`, Binary aus `$CLAUDE_PLUGIN_DATA/bin` (Codex setzt es
  ebenso), abgelöst wie der Build (fork, setsid, stdio auf `/dev/null`,
  cwd `/`, nicht gewartet). Nach `attached` läuft der Hook außerhalb des
  Scopes — `confine()` verschiebt die Session, nicht die Hook-Kette —, also
  kommt der Beobachter per `AttachProcessesToUnit` hinein; nach `already`
  ist der Hook schon drin. `hooks.json` Byte für Byte unverändert (ein Test
  pinnt den SHA-256).
- **Report und CLI**: `--report` hat `learn` (`on`, `file`, `state`,
  `entries`, `rss_limit`); `ignored` nennt `LOADGUARD_LEARN` ≠ `0` und ein
  ungültiges `LOADGUARD_LEARN_RSS`. `loadguard learned` (Nummer, Spitze,
  zuletzt, cwd, Befehl; nur ASCII), `loadguard forget <n>…|--all`; `explain`
  nennt den Treffer im heavy-Label (`yes (learned: …)`); `doctor` hat den
  Abschnitt „learning": Liste, Schwelle in GiB, der Beobachter dieser Session
  (PID aus `<scope>.watch`, deren argv `… --watch …`). Fehlt er in einer
  eingesperrten Session, ist das FAIL.
- **Kosten** (reuben, 318 Prozesse, je 1500 Läufe abwechselnd gegen HEAD,
  `nice`, Prozessstart inklusive): leicht HEAD 0,579 ms → ohne Liste 0,585,
  mit 100 Einträgen (19 KB) 0,713 (p90 0,876), 100 Einträge à 1 KiB
  (117 KB) 0,939 — das Parsen jeder Zeile mit cJSON. Schwer mit Scan 5,716
  → 5,739 ohne, 5,911 mit 100 Einträgen. Ein Takt des Beobachters (Treiber
  mit Produktions-Flags, 1000 Durchläufe über die echten Scopes, Host
  beschäftigt): 27 µs bei einem Prozess bis 0,9 ms bei 34, etwa 15–26 µs je
  Prozess — alle 2 s.
- **Beleg, genauer besehen**: In allen drei Snapshots ist
  `/usr/bin/perl t/json_data.t` (bis 3 746 216 kB, 46,6 % am 2026-09-17) ein
  Kind des MakeMaker-Testharness (`perl -MExtUtils::Command::MM
  -MTest::Harness -e … test_harness(…)`), lief also unter `make test`, das
  die feste Liste schon schwer nennt; die Shell darüber zeigen die Snapshots
  nicht. Die Lernliste bleibt für Befehle außerhalb der Liste — der Beleg
  oben trägt sie weniger, als er klingt.
- **Grenzen, dazu**: bash 5.2 `exec`t den letzten Befehl eines `-c`-Strings
  (auf reuben geprüft, harmlose `sleep`: `bash -c 'sleep 2'` und `bash -c
  'cd /tmp && sleep 2'` hinterlassen nur `sleep`, `'sleep 2; true'` behält
  bash). Codex startet jeden Aufruf als `bash -c <cmd>` — ein einzelner
  Befehl oder `cd x && cmd` läuft also ohne Shell, aus der sich der Text
  lesen ließe, und wird unter Codex **nicht gelernt**; nur Aufrufe, bei
  denen bash bleibt (Pipes, `;`-Listen, Schleifen), liefern argv[2]
  (`test_codex_lone_command_leaves_no_shell`). Claude Code betrifft das
  nicht: Nach dem `eval` folgt `&& pwd -P …`, die Shell bleibt (so
  aufgezeichnet). Deshalb führt `procs/codex-session.json` seit k16 eine
  `;`-Liste aus (`prove -lr t/; echo "exit $?"`: bash 7203 → prove 7204),
  wie live gesehen; mit `prove -lr t/` allein gäbe es bash 7203 nicht. Die
  Slot-Zählung beurteilt argv, es bleibt ein Slot. Überlebt ein `claude
  --bg` die Session, deren Scope er teilt, endet der Beobachter mit dem
  Scope-Eigner; der Rest läuft unbeobachtet weiter. Ein Befehl, den der Beobachter unter Codex liest, der aber anders
  ankommt als gesendet, landet als Text, der nie trifft.
- **Codex live bestätigt** (2026-09-27, codex-cli 0.153.4): argv[2] der
  Shell ist der Befehl des Modells, Byte für Byte — das Snapshot-Skript
  `exec`t genau ihn (`sleep 45; echo "lg probe" 'x'`,
  `t/fixtures/shells/codex.json`, `test_recorded_codex_shell`). bash blieb
  bei der `;`-Liste, `sleep` lief als Kind. Wie oft bash bleibt, hängt
  davon ab, wie das Modell seine Befehle schreibt (siehe Grenzen).
- **Offen**: Claude Codes zsh-Wrapper ist nicht aufgezeichnet (dieselbe Form
  erwartet). zsh ist auf reuben nicht installiert (k14), aufzeichnen lässt
  er sich hier also nicht; gebaut wird dafür nichts. Unter `SHELL=zsh` liest
  die Extraktion ihn, falls er dieselbe Form hat, sonst gilt er als
  unbekannte Form: nichts gelernt, kein Slot über die Lernliste.

### Stufe 4 — Lagebewusstsein (optional)

`UserPromptSubmit`/`SessionStart`: nur wenn die Last erhöht ist, eine Zeile Status in
den Kontext. Im Normalzustand kostet loadguard **null** Kontext-Tokens.

Umgesetzt (k6, `src/loadguard-hook.c`, `hooks/hooks.json`; Tests
`t/test_throttle.py` `Context`, `Calibration`, `LiveHost`,
`t/test_hook_passthrough.py`):

- **Signal = die Druck-Hälfte von k4, genau** (Getty 2026-09-26: wie k4, nicht
  zram): memory `full avg10` ≥ `LOADGUARD_PSI_FULL` oder Swap gesamt ≥
  `LOADGUARD_SWAP_USED`. `under_pressure()` ist die erste Hälfte von
  `no_room()`, beide rufen sie — kein zweiter Vergleich, keine eigene
  Schwelle. **Volle Slots allein geben keine Zeile:** Der Host ist dann in
  Ordnung, ein Slot wird bald frei, und der Deny-Grund sagt es im Moment des
  Versuchs. Kein Slot-Scan, also liest der Pfad auch im Ruhezustand keinen
  fremden Prozess (Test: cmdline als FIFO). `Calibration`: in allen 54
  Snapshots bekommt Thrash die Zeile, ruhig bleibt stumm.
- **Dasselbe Binary, derselbe Starter:** `hook()` verzweigt auf
  `hook_event_name` — `UserPromptSubmit`/`SessionStart` → Zeile oder nichts,
  alles andere → der PreToolUse-Pfad wie bisher (auch ohne
  `hook_event_name`). Kein Python: UserPromptSubmit läuft vor jedem Prompt
  jeder Session.
- **Kanal:** `{"hookSpecificOutput":{"hookEventName":"<Event>",
  "additionalContext":"<Zeile>"}}`, ohne Zeilenumbruch, exit 0. Laut
  Hooks-Docs (code.claude.com/docs/en/hooks, gelesen 2026-09-26) landen bei
  beiden Events Plain-stdout **und** `additionalContext` als System-Reminder
  im Kontext: UserPromptSubmit neben dem Prompt, SessionStart vor dem ersten.
  JSON, weil Codex (k11) dieselbe Form annimmt, aber unbekannte
  Top-Level-Keys ablehnt; deshalb nur `hookSpecificOutput`.
- **Synchron.** Async-Hooks werden laut Docs nicht verworfen: ihr
  `additionalContext` kommt „on the next conversation turn", und `-p` killt
  sie beim Beenden — für SessionStart zu spät oder gar nicht. Synchron kostet
  ~0,6 ms; Claudes erste Antwort wartet ohnehin auf die SessionStart-Hooks.
  Timeout 5 s wie PreToolUse (Default auf UserPromptSubmit: 30 s; ein
  Timeout verwirft die Ausgabe, der Prompt geht ohne Zeile durch).
- **Live bestätigt** (2026-09-26, `claude -p --plugin-dir` mit Haiku,
  `LOADGUARD_PSI_FULL=1 LOADGUARD_SWAP_USED=1`, Claude Code 2.1.283): Die
  Zeile kommt über SessionStart und UserPromptSubmit beim Modell an, es
  zitiert beide wörtlich. `make test` verweigert der Hook; das Modell sieht
  das als fehlgeschlagenen Tool-Aufruf `PreToolUse:Bash hook error: <Grund>`
  (`is_error`) und gibt den Grund korrekt wieder. Kosten 0,02 $.
- **Nie exit 2:** Auf UserPromptSubmit blockiert exit 2 den Prompt und löscht
  ihn. Jeder Pfad endet mit exit 0; Test: Produktions-Binary direkt und über
  den Starter, gültige, kaputte, leere und zu große Payloads, drei
  Umgebungen.
- **Die Zeile**, englisch, eine Zeile, höchstens 216 Zeichen (100 % gegen
  Grenzen von 100 %), Tatsachen statt Anweisungen — die Docs warnen, dass als
  System-Anweisung formulierter Text die Prompt-Injection-Abwehr auslösen
  kann:

  > loadguard: memory pressure full=59.9% (limit 10%), swap 100% used (limit
  > 90%). Heavy commands refused until it eases: prove, make test, builds, new
  > claude -p/--bg. Light commands still run; see `loadguard status`.

  Die Zahlen formatiert `pressure_figures()`, wie im Deny-Grund (dort folgt
  zram). **Kein Testlauf als Rat**, auch kein kleiner — aus demselben Grund
  wie im Deny-Grund unter Druck (k4 oben): Jeder Lauf zieht Speicher, und ein
  Befehl, den der Klassifizierer durchlässt (ein erster Entwurf nannte `perl
  -Ilib t/x.t`), zeigte der KI den Weg um den Wächter. `loadguard status`
  geht, weil `bin/` auf dem PATH des Bash-Tools liegt (k5).
- **Kein Zustand:** Unter Druck bekommt jeder Prompt die Zeile, kein Dedup —
  Einfachheit vor ein paar Tokens in einem seltenen Zustand.
- **`LOADGUARD_THROTTLE=0` schaltet auch die Zeile ab:** Ohne Verweigern wäre
  sie falsch. Ein Schalter für „nichts verweigern, nichts melden".
- **Report-Modi:** keine neue Angabe. `--report` hat `throttle` und
  `pressured`; die Zeile erscheint genau, wenn beide `true` sind (Test
  `test_same_pressure_as_the_hook`, samt denselben Zahlen wie im Deny-Grund).
- **Kosten** (reuben, je 1500 Läufe abwechselnd gegen HEAD, `nice`):
  PreToolUse leicht 0,559 → 0,555 ms, schwer 4,139 → 4,130 ms Median —
  unverändert. UserPromptSubmit ruhig 0,61 ms, SessionStart 0,68 ms, mit
  Zeile (Grenzen per Env erzwungen) 0,60 ms.
- **Erste Session nach der Installation:** Das Binary wird async gebaut, bis
  dahin gibt der Starter nichts aus — keine Zeile, fail-open wie PreToolUse.

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

### Codex (k11)

Dasselbe Plugin für Codex (`codex-cli 0.153.4` auf reuben), nachgelesen in
den Quellen `rust-v0.153.4` (codex-rs, Pfade unten relativ dazu). Getty
2026-09-26: Macht Codex echte Probleme, bleibt es draußen.

Umgesetzt (k11, `.codex-plugin/plugin.json`, `lib/loadguard/confine.py`,
`src/loadguard-hook.c`; Tests `t/test_hook_passthrough.py` `CodexRuns`,
`PluginWiring`, `t/test_confine.py`, `t/test_throttle.py`
`CodexPayloads`, Fixtures `t/fixtures/codex/`,
`t/fixtures/procs/codex-*.json`):

- **Ein `hooks/hooks.json` für beide**, wie bei `~/dev/briefing`.
  `.codex-plugin/plugin.json` hat dieselben Felder wie
  `.claude-plugin/plugin.json` plus `hooks: "./hooks/hooks.json"`, keine
  Skills; ein Test verlangt jedes gemeinsame Feld gleich, damit ein Release
  nicht nur eine Version hebt. Codex liest die Datei mit
  `deny_unknown_fields` nur auf oberster Ebene (`description`, `hooks`;
  `config/src/hook_config.rs:10-17`), ein Handler ignoriert Unbekanntes —
  auch Claude Codes `args` (161-185). Timeout-Default wäre 600 s
  (`hooks/src/engine/discovery.rs:762`); wir setzen 5/10.
- **Wie Codex einen Hook startet:** `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`,
  `${PLUGIN_DATA}`, `${CLAUDE_PLUGIN_DATA}` werden im Befehlstext ersetzt
  und in die Umgebung gesetzt (`discovery.rs:262-270, 566-568`), dann
  `<Session-Shell> -c <Befehl>` (`core/src/session/mod.rs:4666`,
  `hooks/src/engine/command_runner.rs:390-426`), Umgebung = die von codex
  selbst (`hooks/src/registry.rs:77`). Ohne `args` finden alle drei
  Einträge das Datenverzeichnis über `$CLAUDE_PLUGIN_DATA`; `CodexRuns`
  startet jeden Eintrag genau so. Hooks laufen nicht in der Sandbox (von
  codex selbst gestartet, eigene Prozessgruppe, `command_runner.rs:216-242`)
  — busctl erreicht den User-Bus.
  Datenverzeichnis `~/.codex/plugins/data/<plugin>-<marketplace>`
  (`core-plugins/src/store.rs:141`) = derselbe Name wie bei Claude Code
  (`loadguard-getty`): `bin/loadguard` findet das Binary über den
  Installationspfad.
- **Ereignisse:** SessionStart kommt beim ersten Turn, vor
  UserPromptSubmit (`core/src/session/turn.rs:264-268`); gespawnte
  Subagenten bekommen SubagentStart statt SessionStart
  (`core/src/hook_runtime.rs:130-146`) — ihr PreToolUse trägt
  `agent_id`/`agent_type`. Das Shell-Tool (`exec_command`) erreicht
  PreToolUse als `tool_name: "Bash"`, `tool_input: {"command": …}` ohne
  weitere Felder (`core/src/tools/handlers/unified_exec/exec_command.rs:504-515`).
  Deny-JSON und `additionalContext` sind die Claude-Code-Formen; die
  Ausgabe-Structs lehnen unbekannte Felder ab (`hooks/src/schema.rs`), also
  nur `hookSpecificOutput` (schon seit k6). Exit ≠ 0 außer 2 und ein
  Timeout blockieren bei Codex nicht, sie erscheinen als Hook-Fehler
  (`hooks/src/events/pre_tool_use.rs:278-291`, `command_runner.rs:317-327`)
  — fail-open wie bei Claude Code. `CodexPayloads`: für
  jede Wurzel, Umgebung und jeden Befehl dieselben Bytes wie mit dem
  Claude-Code-Payload, Deny wie Kontextzeile.
- **Einsperren:** Sessionprozess ist der nächste Vorfahr mit `comm` oder
  `argv[0]` `claude` **oder `codex`** (`session_name()`,
  `find_session()`; npm-Start: node → `vendor/<triple>/bin/codex`, der
  zählt). Name, Slice und Idempotenz wie bisher; die Unit-Beschreibung
  nennt den Harness (`loadguard: codex session <id>`), das Statuswort heißt
  `no-session`, die CLI „not run from a Claude Code or Codex session".
  `codex exec` hostet seine Session immer im eigenen Prozess
  (`exec/src/lib.rs:812`), die TUI eingebettet
  (`tui/src/lib.rs:255-282`) — **außer** ein lokaler App-Server-Daemon
  antwortet binnen 50 ms auf seinem Socket und der Start hat keine
  Overrides wie `-c` (`tui/src/lib.rs:447-470, 860-929`). Der Daemon
  (`codex app-server [--remote-control] --listen unix://`, per `setsid`
  abgelöst, `app-server-daemon/src/backend/pid.rs:156-182, 413-421`;
  ebenso der `codex app-server` der VS-Code-Extension,
  `app-server/README.md:3`) hostet viele Threads in einem
  Prozess und startet ihre Hooks. **Entschieden: ein gemeinsamer Scope, kein
  Überspringen.** Der erste Thread schiebt den Daemon in
  `loadguard-<thread>-<pid>.scope`, alle weiteren finden ihn dort
  („already") und teilen das Limit — dieselbe Regel wie bei verschachteltem
  `claude -p`. Das ist nie schwächer als ein Scope pro Session; Überspringen
  ließe genau diese Sessions ganz ohne Grenze laufen und ihre Befehle
  außerhalb der Slice, also auch für die Slot-Zählung unsichtbar. Preis:
  Threads verschiedener Projekte bremsen einander bei `MemoryHigh`, der
  Scope trägt den Namen des ersten Threads und lebt so lange wie der
  Daemon. Auf reuben war Remote Control schon einmal an
  (`~/.codex/app-server-daemon/settings.json`), der Daemon lief am
  2026-09-26 nicht.
- **Schwer (eingehend):** `codex exec` und sein Alias `codex e`
  (`codex --help`) sind wie `claude -p`/`--bg` eine neue Headless-Session:
  schwer beim Start, kein Slot. Gesucht wird das Wort irgendwo nach
  `codex`, wie `-p` bei claude — Codex nimmt globale Optionen vor dem
  Unterbefehl (`codex -m o3 exec …`). Die Art heißt jetzt `K_AGENT`; ihr Rat
  nennt beide: „Do not start new `claude -p`/`claude --bg` or `codex exec`
  sessions now; do the work in this one." Die Kontextzeile bleibt: Sie
  steht mit 216 Zeichen genau an ihrer Grenze (`test_line_stays_short`),
  „, codex exec" passt nicht hinein; verweigert wird es trotzdem.
- **Schwer (laufend):** Codex führt Befehle auf reuben (`workspace-write`,
  kein System-bwrap) so aus: codex → `codex-linux-sandbox` (Symlink auf
  codex, `comm` `codex-linux-san`) → gebündeltes `bwrap` (per
  `/proc/self/fd/N` gestartet, `comm` ist die Zahl) → wieder
  `codex-linux-sandbox` als PID 1 der neuen Namespaces (`comm` `codex`) →
  `/bin/bash -c <cmd>` → prove. Kein cgroup-Namespace: alles liegt im
  Scope. Die Helfer haben den Befehl erst hinter `--` in argv; beurteilt
  wird argv[0] — sie sind leicht und verdecken nichts
  (`codex-session.json`, Belegstellen in `t/fixtures/README.md`). `bash
  -lc` (vor dem Shell-Snapshot) ist kein erkannter Inline-Code-Schalter:
  Der Codetext wird wie ein Skriptpfad beurteilt und ist nur als nacktes
  `prove` schwer — dann hält die Shell statt prove denselben einen Slot.
- **Kosmetik, gelassen (bis k14):** Codex hängt an den Grund `. Command: <cmd>`
  (`core/src/hook_runtime.rs:229-234`); unser Grund endet mit `.`, das
  Modell liest `run..`. Ändern hieße, Claude Codes Bytes zu ändern oder den
  Harness zu erkennen — nicht trivial genug. Seit k14 erkennt der Hook den
  Harness (unten).
- **Grenzen:** Codex legt das `bin/` eines Plugins nicht auf den PATH der
  Shell (nur Paket- und zsh-Pfad, `core/src/tools/runtimes/mod.rs:118-144`)
  — `loadguard status` in der Kontextzeile fand ein Codex-Modell nicht
  unter diesem Namen (seit k14 nennt die Zeile es unter Codex nicht mehr).
  In der Sandbox ist `/proc` das des eigenen
  PID-Namespace (`--proc /proc`): `status`/`explain` von dort sehen nur die
  eigenen Prozesse; vom Terminal aus aufrufen. Hooks laufen erst nach dem
  Trust-Prompt, pro Handler, und eine geänderte hooks.json verlangt neuen
  Trust (`discovery.rs:676-725, 794-812`); `codex exec` kann ihn nicht
  erteilen.
- **Live bestätigt (2026-09-27)** mit Getty: codex-cli 0.153.4, loadguard
  0.2.0 aus dem Marketplace `getty-dev`, `LOADGUARD_PSI_FULL=1
  LOADGUARD_SWAP_USED=1`, damit die ruhige Lage als Druck gilt — ohne Last.
  Belege im Rollout der Session
  (`~/.codex/sessions/2026/09/27/rollout-2026-09-27T02-13-01-01a0e035-….jsonl`):
  - Einsperren: codex (pid 352696) in `loadguard-01a0e035-352696.scope`,
    Beschreibung `loadguard: codex session 01a0e035-…`.
  - Erster Prompt direkt nach der Installation: keine Kontextzeile
    (SessionStart und UserPromptSubmit 02:13:04, Binary erst 02:13:07
    gebaut), kein Beobachter in dieser Session (confine lief vor dem Build)
    — wie für die erste Session beschrieben (Lernliste, Stufe 4).
    PreToolUse griff um 02:13:09 schon.
  - Zweiter Prompt: die Kontextzeile kommt als developer-Nachricht an;
    `git status` läuft, `make test` und `codex exec` werden verweigert, der
    Grund mit angehängtem `. Command: <cmd>` — das `..` von oben (k14).
  - Codex rief die Befehle über code mode auf (`exec` →
    `tools.exec_command({cmd: …})`); der Hook griff trotzdem.
  - Shell: `sleep 45; echo "lg probe" 'x'` lief als `/bin/bash -c <cmd>`,
    argv[2] Byte für Byte der `cmd` des Modells
    (`t/fixtures/shells/codex.json`); der Rollout nennt den Aufruf
    `/bin/bash -lc <cmd>`, die Form vor dem Snapshot-Skript. bash blieb
    (`;`-Liste), `sleep` als Kind.
  - Kette im Scope wie aus den Quellen rekonstruiert: codex →
    `codex-linux-sandbox` (argv[0]
    `~/.codex/tmp/arg0/codex-arg0XXXX/codex-linux-sandbox`,
    `--sandbox-policy-cwd … --command-cwd …`) → bwrap (`comm` `3`,
    `bwrap --as-pid-1 --new-session --die-with-parent --ro-bind / / …`) →
    `codex-linux-sandbox` (`comm` `codex`) → `/bin/bash -c <cmd>` →
    `sleep 45`; daneben `codex-code-mode-host` und ein MCP-Server
    (`python3 -I -c …`). `procs/codex-session.json` folgt dem (k16).
  - Danach der Eintrag in `.agents/plugins/marketplace.json` von
    `Getty/marketplace` (cbdd3af): `codex plugin add loadguard@getty`.

### Umgesetzt (k14): Codex-Nachzügler

`src/loadguard-hook.c` (`CODEX_HEADLESS`, `advice()`, `from_codex()`,
`objection()`, `situation()`); Tests `t/test_throttle.py` `CodexPayloads`
(umgestellt), `Decide`, `Slots`, `Matcher`, `t/test_learn.py` `Hook`.
Quellen: codex-rs `rust-v0.153.4`.

- **`codex review` ist schwer** wie `codex exec`: Es ist `exec` mit einem
  Review-Auftrag im eigenen Prozess (`cli/src/main.rs:136-141, 1160-1174`:
  `ExecCli` mit `ExecCommand::Review`, `codex_exec::run_main`), ohne Alias.
  `K_AGENT`, hält keinen Slot; gesucht wird das Wort wie `exec` irgendwo
  nach `codex`. Der Rat nennt es mit: „Do not start new `claude -p`/`claude
  --bg` or `codex exec`/`codex review` sessions now; do the work in this
  one." Die Kontextzeile nennt weiter nur `claude -p/--bg` (216 Zeichen).
- **Harness erkennen, Claude Codes Bytes unverändert.** Unter Codex endet
  (a) der Grund ohne Schlusspunkt — Codex hängt `. Command: <cmd>` an
  (`core/src/hook_runtime.rs:229-234`), das Modell las live `run..` —, und
  (b) fehlt der Kontextzeile „; see `loadguard status`": kein Plugin-`bin/`
  auf dem PATH, in der Sandbox zeigt `/proc` nur die Sandbox. Entscheidung
  und alles andere bleiben gleich; `--explain` schreibt den Grund wie der
  Hook für dasselbe Payload.
- **Signal** (`from_codex()`, kein Dateizugriff: eine Schlüsselsuche im
  schon geparsten Payload, auf SessionStart zwei `getenv`):
  - PreToolUse, UserPromptSubmit: `turn_id` als String im Payload. Codex
    setzt es auf allen turn-bezogenen Eingaben als Pflichtfeld („Codex
    extension", `hooks/src/schema.rs:280-281, 569-570`, Test
    `turn_scoped_hook_inputs_include_codex_turn_id_extension`, 1101-1170);
    Claude Codes PreToolUse und UserPromptSubmit haben keins (aufgezeichnet
    k7, hooks-Doku gelesen 2026-09-27).
  - SessionStart: `SessionStartCommandInput` hat kein `turn_id` und kein
    Feld, das Claude Code nicht auch schickt (`schema.rs:499-510`:
    `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
    `permission_mode`, `source`). Deshalb die Umgebung: Codex setzt jedem
    Hook eines Plugins `PLUGIN_ROOT` und `CLAUDE_PLUGIN_ROOT` auf denselben
    Pfad (`hooks/src/engine/discovery.rs:262-270`) und scrubbt sie nicht
    (`protocol/src/shell_environment.rs:14-50`); Claude Code exportiert
    `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`
    (hooks-Doku), kein `PLUGIN_ROOT`. Unter Codex läuft loadguard nur als
    Plugin (sonst findet der Starter kein `$CLAUDE_PLUGIN_DATA`), das Signal
    fehlt dort also nie. Gleichheit statt bloßem Vorhandensein: Claude Codes
    Hooks erben Claudes Umgebung, ein `PLUGIN_ROOT` eines anderen Werkzeugs
    darin zählt nicht.
  - Verworfen: `transcript_path` (`~/.codex/sessions/…/rollout-*`, darf
    `null` sein, hängt an `CODEX_HOME`), UUIDv7 der `session_id`,
    `model`-Namen — Konventionen, keine Zusagen; `CODEX_THREAD_ID` erbt
    jede Shell von Codex, also auch ein darin gestartetes `claude`.
  - Ohne Signal gilt Claude Codes Form, wie bis k14. Ein falscher Treffer
    kostet einen Punkt oder den Hinweis, nie eine Entscheidung.
  - **Risiko:** Claude Code kennt `turn_id` schon (Eingabe von
    MessageDisplay, hooks-Doku 2026-09-27). Bekommt auch sein PreToolUse
    eins, verliert Claude Codes Grund den Punkt — dann auf das
    Umgebungssignal für alle Ereignisse wechseln.
- **Grenzen, dokumentiert statt gebaut** (Getty: der exakte Text, keine
  Rekonstruktion aus argv): ein einzelner Befehl ist unter Codex nicht
  lernbar (bash `exec`, k15); ein unter Claude Code gelernter wird unter
  Codex beim Eintritt verweigert, hält laufend aber keinen Slot (Lernliste,
  Grenzen); Claude Codes zsh-Wrapper bleibt unaufgezeichnet, zsh fehlt auf
  reuben.
- **Kosten** (reuben, 313 Prozesse, je 1500 leichte und 500 schwere Läufe,
  alle vier Fälle je Durchgang verschränkt, HEAD und neu abwechselnd,
  `nice`, Prozessstart inklusive; Median/p90 in ms): leicht Claude
  0,502/0,650 → 0,501/0,660, leicht Codex 0,504/0,657 → 0,504/0,651; schwer
  mit Scan Claude 4,735/5,724 → 4,733/5,916, Codex 4,749/5,880 →
  4,739/5,831. Kein messbarer Unterschied.
- **Geprüft:** HEAD- gegen neuen Testtreiber, 6780 Läufe (alle Muster- und
  leichten Befehle der Tests, synthetisches und aufgezeichnetes
  Claude-Payload, beide Kontextereignisse, drei Wurzeln, fünf Umgebungen
  samt Claude Codes, `decide` und `explain`): Unterschiede nur bei
  `K_AGENT`-Befehlen (Rat) und bei `codex review` (neu schwer).

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
