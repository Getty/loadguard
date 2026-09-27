/*
 * loadguard-hook — PreToolUse hook on Bash, the compiled path (k8, k4); also
 * UserPromptSubmit and SessionStart (k6).
 *
 * Silent (no stdout, exit 0: the command runs as is) unless the command is
 * heavy and the host has no room for it. Then it prints the documented deny
 * JSON, whose reason Claude Code hands to the model — still exit 0.
 *
 * On UserPromptSubmit and SessionStart (hook_event_name) it prints one line
 * of context while memory is under pressure (no room, point 1 below; full
 * slots alone do not count) and nothing otherwise: zero context tokens when
 * calm. No slot scan, no state across prompts.
 *
 * Heavy: a simple command of the Bash string — at its start, after ; & | ( )
 * ` or a newline, past VAR=x assignments and prefixes like nice, timeout or
 * env — runs prove, dzil test|build|release, make … test, cpanm,
 * docker|podman build|run, cargo build|test, npm test, perlbench,
 * claude -p|--print|--bg or codex exec|e|review. Quotes, comments and heredoc
 * bodies are not commands. Also heavy: a command whose exact text is in the
 * learned list (k15, below). Everything else is light and costs one read
 * beyond stdin — the learned list, a failed open() while there is none.
 *
 * No room (docs/design.md, Stufe 2/3, "Umgesetzt (k4)"):
 *  1. memory PSI full avg10 >= LOADGUARD_PSI_FULL (10 %) or total swap used
 *     >= LOADGUARD_SWAP_USED (90 %). Denied without scanning /proc: reading
 *     another process's cmdline faults its argument pages in, which under
 *     thrash can outlast the hook timeout — and a timed-out hook lets the
 *     command run.
 *  2. else: heavy processes already running under app-loadguard.slice (every
 *     confined session) >= LOADGUARD_HEAVY_SLOTS (max(1, nproc/2)). One
 *     running command is one slot: processes are judged by their argv, not
 *     by the text of the Bash wrapper around them, and only the topmost
 *     heavy process of a chain counts (prove's perl children, a recursive
 *     make). claude -p/--bg and codex exec/review sessions hold no slot;
 *     what they run does. Codex's sandbox helpers (codex-linux-sandbox,
 *     bwrap) are no heavy process and hide none (k11). A shell running a
 *     learned command holds a slot too (k15).
 * LOADGUARD_THROTTLE=0 (only that exact value): pure pass-through, and no
 * context line — nothing is refused, so there is nothing to warn about.
 *
 * Codex (k14) gets the same answers in two spellings of its own: the deny
 * reason without its final period (Codex appends ". Command: <cmd>"), the
 * context line without the pointer to `loadguard status` (not on Codex's
 * PATH). from_codex() tells the harness from the payload and, on
 * SessionStart, the environment — no file. Claude Code's bytes stay as
 * they were.
 *
 * The learned list (k15, docs/design.md "Lernliste"):
 * ${XDG_STATE_HOME:-~/.local/state}/loadguard/learned.jsonl, one JSON object
 * per line, the exact tool_input.command of a Bash call whose processes
 * once held LOADGUARD_LEARN_RSS (20) % of MemTotal between them. Written by
 * `--watch PID`, one watcher per session scope, started detached by
 * hooks/loadguard-confine; read by the hook. LOADGUARD_LEARN=0: no watcher,
 * list ignored. A broken, oversized or unreadable list counts as empty.
 *
 * Fail open: whatever goes wrong (empty or oversized stdin, not UTF-8, broken
 * JSON, missing fields, out of memory) ends in exit 0 with nothing on stdout.
 * An unreadable measurement counts as room: no PSI, no swap figure, no /proc
 * entry — no objection from that source. Never exit 2: that is the only
 * code with which a hook blocks regardless of its output — on
 * UserPromptSubmit it would erase the user's prompt.
 *
 * Cheap: no fork, no exec, no file other than stdin and the learned list on
 * the light path; the context events read /proc/pressure/memory and
 * /proc/meminfo only. JSON only via the vendored cJSON (vendor/cJSON/) —
 * commands carry escapes, heredocs, Unicode.
 *
 * Commands are never rewritten (k3): confinement is per session, done on
 * SessionStart (hooks/loadguard-confine). This hook only stays silent,
 * denies, or adds its line of context.
 *
 * Hook mode is any call but the three below; hooks/loadguard execs the
 * binary without arguments. For bin/loadguard (k5) there are two read-only
 * report modes, one line of JSON on stdout each:
 *   --report     the host as the heavy path sees it: limits, pressure, slots
 *                (not scanned under pressure, as in the hook), the learned
 *                list; reads no stdin
 *   --explain    a hook payload on stdin: the hook's answer and what it
 *                measured on the way
 * Both run objection() and no_room(), the functions the hook runs; nothing
 * in them decides on its own. And the watcher (k15):
 *   --watch PID  PID is the session process a loadguard-*.scope was made
 *                for; watch that scope every 2 s until PID is gone. Reads
 *                no stdin, prints nothing, always exits 0.
 *
 * Built with -DLOADGUARD_TEST, main() is swapped for a test driver that
 * exposes the extraction, the matcher, the measurement, the decision, the
 * reports and the watcher against a fixture root (t/test_hook_binary.py,
 * t/test_throttle.py, t/test_learn.py); the production binary reads the
 * real /proc and has no test mode.
 */

#define _GNU_SOURCE

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "cJSON.h"

/* Larger payloads pass through unparsed. */
#define MAX_PAYLOAD ((size_t)8 << 20)

/* Defaults, calibrated on ~/load-incidents (docs/design.md, k4). */
#define PSI_FULL_DEFAULT 10     /* % memory full avg10: calm <= 2.03, thrash >= 45.47 */
#define SWAP_USED_DEFAULT 90    /* % of all swap: calm <= 68.3, thrash >= 91.9 */

#define SLICE "app-loadguard.slice"

/*
 * All of stdin as a NUL-terminated heap buffer, its length in *len.
 * NULL on a read error or above MAX_PAYLOAD; then the rest is drained, so
 * the writer never gets EPIPE.
 */
static char *read_stdin(size_t *len)
{
    size_t cap = 64 * 1024, n = 0;
    char *buf = malloc(cap + 1);

    while (buf != NULL) {
        ssize_t r;
        if (n == cap) {
            char *bigger;
            if (cap >= MAX_PAYLOAD)
                break;
            cap *= 2;
            bigger = realloc(buf, cap + 1);
            if (bigger == NULL)
                break;
            buf = bigger;
        }
        r = read(STDIN_FILENO, buf + n, cap - n);
        if (r == 0) {
            buf[n] = '\0';
            *len = n;
            return buf;
        }
        if (r < 0) {
            if (errno == EINTR)
                continue;
            free(buf);
            return NULL;
        }
        n += (size_t)r;
    }

    free(buf);
    {
        char sink[65536];
        ssize_t r;
        while ((r = read(STDIN_FILENO, sink, sizeof sink)) != 0)
            if (r < 0 && errno != EINTR)
                break;
    }
    return NULL;
}

/*
 * Well-formed UTF-8 without NUL bytes. cJSON checks neither: a stray byte
 * would reach a deny reason verbatim, a NUL would end the text early.
 */
static int valid_utf8(const unsigned char *s, size_t n)
{
    size_t i = 0;

    while (i < n) {
        unsigned c = s[i], cp, min;
        size_t k, j;

        if (c == 0)
            return 0;
        if (c < 0x80) {
            i++;
            continue;
        }
        if ((c & 0xE0) == 0xC0) {
            k = 1; cp = c & 0x1F; min = 0x80;
        } else if ((c & 0xF0) == 0xE0) {
            k = 2; cp = c & 0x0F; min = 0x800;
        } else if ((c & 0xF8) == 0xF0) {
            k = 3; cp = c & 0x07; min = 0x10000;
        } else {
            return 0;
        }
        if (n - i <= k)
            return 0;
        for (j = 1; j <= k; j++) {
            if ((s[i + j] & 0xC0) != 0x80)
                return 0;
            cp = (cp << 6) | (s[i + j] & 0x3F);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
            return 0;
        i += k + 1;
    }
    return 1;
}

/* The payload as a cJSON tree; NULL unless it is one UTF-8 JSON text. */
static cJSON *parse_payload(const char *buf, size_t len)
{
    if (!valid_utf8((const unsigned char *)buf, len))
        return NULL;
    /* len + 1 takes in the terminating NUL: nothing may follow the text. */
    return cJSON_ParseWithLengthOpts(buf, len + 1, NULL, 1);
}

/* tool_input of a Bash payload whose command is a string, else NULL. */
static const cJSON *bash_tool_input(const cJSON *payload)
{
    const cJSON *name, *input;

    if (!cJSON_IsObject(payload))
        return NULL;
    name = cJSON_GetObjectItemCaseSensitive(payload, "tool_name");
    input = cJSON_GetObjectItemCaseSensitive(payload, "tool_input");
    if (!cJSON_IsString(name) || strcmp(name->valuestring, "Bash") != 0)
        return NULL;
    if (!cJSON_IsObject(input) ||
        !cJSON_IsString(cJSON_GetObjectItemCaseSensitive(input, "command")))
        return NULL;
    return input;
}

/* ------------------------------------------------------------------------
 * Heavy commands — one classifier for the words of an incoming command and
 * for the argv of a running process.
 */

enum kind {
    K_NONE,
    K_PROVE,        /* prove */
    K_SUITE,        /* a whole test suite: make test, dzil test|release, … */
    K_BUILD,        /* builds, installs, containers, perlbench */
    K_AGENT,        /* claude -p|--print|--bg, codex exec|e|review: a new
                       headless agent session, heavy to start, holds no
                       slot */
    K_LEARNED       /* the exact text of a command in the learned list (k15) */
};

struct match {
    enum kind kind;
    int at;             /* index of the command word in the argv judged */
    char label[64];     /* "prove", "make test", "podman run", "learned: …" */
};

static const char *const INTERPRETERS[] = {
    "perl", "python", "python3", "node", "sh", "bash", "dash", NULL
};

/*
 * Arguments that make an agent CLI start a headless session, anywhere after
 * the command word: Codex takes global options before the subcommand
 * (`codex -m o3 exec …`); `e` is exec's alias (`codex --help`, 0.153.4).
 * `codex review` is exec running a review, in its own process
 * (codex-rs cli/src/main.rs:1160-1174, rust-v0.153.4); it has no alias.
 */
static const char *const CLAUDE_HEADLESS[] = {"-p", "--print", "--bg", NULL};
static const char *const CODEX_HEADLESS[] = {"exec", "e", "review", NULL};

static const char *base(const char *s)
{
    const char *slash = strrchr(s, '/');
    return slash ? slash + 1 : s;
}

static int one_of(const char *s, const char *const *list)
{
    for (; *list != NULL; list++)
        if (strcmp(s, *list) == 0)
            return 1;
    return 0;
}

/* The first argument that is no option (-x, --x, cargo's +toolchain). */
static const char *subcommand(char *const *av, int ac)
{
    int i;
    for (i = 1; i < ac; i++)
        if (av[i][0] != '-' && av[i][0] != '+')
            return av[i];
    return "";
}

/*
 * What argv runs, judged by its words: the basename of argv[0] and, for
 * tools with subcommands, the first argument that is no option. An
 * interpreter is looked through to its script — the kernel runs prove as
 * `/usr/bin/perl /usr/bin/prove -lr t/` — but inline code (-c, -e, -E) is
 * no script: Claude Code's `bash -c '… eval …'` wrapper is not what it runs.
 */
static enum kind classify(char *const *av, int ac, struct match *m)
{
    const char *name, *sub;
    enum kind kind = K_NONE;
    int at = 0, i;

    if (ac < 1)
        return K_NONE;
    if (one_of(base(av[0]), INTERPRETERS)) {
        for (at = 1; at < ac && av[at][0] == '-'; at++)
            if (strcmp(av[at], "-c") == 0 || strcmp(av[at], "-e") == 0 ||
                strcmp(av[at], "-E") == 0)
                return K_NONE;
        if (at == ac)
            return K_NONE;
    }
    av += at;
    ac -= at;
    name = base(av[0]);
    sub = subcommand(av, ac);

    if (strcmp(name, "prove") == 0) {
        kind = K_PROVE;
        sub = "";
    } else if (strcmp(name, "cpanm") == 0 || strcmp(name, "perlbench") == 0) {
        kind = K_BUILD;
        sub = "";
    } else if (strcmp(name, "dzil") == 0) {
        if (strcmp(sub, "build") == 0)
            kind = K_BUILD;
        else if (strcmp(sub, "test") == 0 || strcmp(sub, "release") == 0)
            kind = K_SUITE;
    } else if (strcmp(name, "make") == 0) {
        for (i = 1; i < ac && kind == K_NONE; i++)
            if (strcmp(av[i], "test") == 0) {
                kind = K_SUITE;
                sub = "test";
            }
    } else if (strcmp(name, "docker") == 0 || strcmp(name, "podman") == 0) {
        if (strcmp(sub, "build") == 0 || strcmp(sub, "run") == 0)
            kind = K_BUILD;
    } else if (strcmp(name, "cargo") == 0) {
        if (strcmp(sub, "build") == 0)
            kind = K_BUILD;
        else if (strcmp(sub, "test") == 0)
            kind = K_SUITE;
    } else if (strcmp(name, "npm") == 0) {
        if (strcmp(sub, "test") == 0)
            kind = K_SUITE;
    } else if (strcmp(name, "claude") == 0 || strcmp(name, "codex") == 0) {
        const char *const *headless =
            strcmp(name, "claude") == 0 ? CLAUDE_HEADLESS : CODEX_HEADLESS;
        for (i = 1; i < ac && kind == K_NONE; i++)
            if (one_of(av[i], headless)) {
                kind = K_AGENT;
                sub = av[i];
            }
    }
    if (kind != K_NONE) {
        m->kind = kind;
        m->at = at;
        snprintf(m->label, sizeof m->label, "%s%s%s", name,
                 *sub ? " " : "", sub);
    }
    return kind;
}

/*
 * Splitting a Bash string into simple commands. No shell parser: quotes,
 * backslashes, comments, redirections and heredocs are followed as far as
 * it takes to find the command word; anything unusual errs towards light.
 */

#define MAX_WORDS 32
#define WORD_MAX 256
#define MAX_HEREDOCS 8
#define DELIM_MAX 64

struct words {
    int n;              /* words complete */
    int len;            /* bytes in the open word */
    int open;           /* a word is open ('' opens an empty one) */
    int skip;           /* the next word is a redirection target */
    char w[MAX_WORDS][WORD_MAX];
};

static void begin(struct words *s)
{
    if (!s->open) {
        s->open = 1;
        s->len = 0;
    }
}

static void put(struct words *s, char c)
{
    begin(s);
    if (s->n < MAX_WORDS && s->len < WORD_MAX - 1)
        s->w[s->n][s->len++] = c;
}

static void end_word(struct words *s)
{
    if (!s->open)
        return;
    s->open = 0;
    if (s->skip)
        s->skip = 0;
    else if (s->n < MAX_WORDS)
        s->w[s->n++][s->len] = '\0';
}

/* Words in front of the command word that keep it in command position. */
static const char *const PREFIXES[] = {
    "!", "{", "}", "if", "then", "else", "elif", "while", "until", "do",
    "time", "exec", "nice", "ionice", "nohup", "timeout", "env", "stdbuf",
    "setsid", "xargs", NULL
};

static int assignment(const char *w)
{
    if (!isalpha((unsigned char)*w) && *w != '_')
        return 0;
    while (isalnum((unsigned char)*w) || *w == '_')
        w++;
    return *w == '=' || (w[0] == '+' && w[1] == '=');
}

/* Judge the collected simple command, then start the next one. */
static enum kind end_command(struct words *s, struct match *m)
{
    char *av[MAX_WORDS];
    int i, ac = 0, prefixed = 0;
    enum kind kind;

    end_word(s);
    s->skip = 0;
    for (i = 0; i < s->n; i++) {
        const char *w = s->w[i];
        if (assignment(w))
            continue;
        if (prefixed && (w[0] == '-' || isdigit((unsigned char)w[0])))
            continue;           /* nice -n 10, timeout 5m, xargs -P4 */
        if (one_of(w, PREFIXES)) {
            prefixed = 1;
            continue;
        }
        break;
    }
    for (; i < s->n; i++)
        av[ac++] = s->w[i];
    kind = classify(av, ac, m);
    s->n = 0;
    return kind;
}

/*
 * p is at the first '<' of "<<" or "<<-". Reads the delimiter word (quotes
 * removed) into delim; returns the last character consumed.
 */
static const char *heredoc_start(const char *p, char *delim, int *strip)
{
    size_t n = 0;
    char quote = 0;

    p += 2;
    *strip = 0;
    if (*p == '-') {
        *strip = 1;
        p++;
    }
    while (*p == ' ' || *p == '\t')
        p++;
    for (; *p != '\0'; p++) {
        if (quote) {
            if (*p == quote)
                quote = 0;
            else if (n < DELIM_MAX - 1)
                delim[n++] = *p;
            continue;
        }
        if (*p == '\'' || *p == '"') {
            quote = *p;
            continue;
        }
        if (*p == '\\' && p[1] != '\0')
            p++;
        else if (strchr(" \t\n;&|()<>`", *p) != NULL)
            break;
        if (n < DELIM_MAX - 1)
            delim[n++] = *p;
    }
    delim[n] = '\0';
    return p - 1;
}

/*
 * p is at the newline that ends the line with the heredoc operators. Skips
 * their bodies; returns the newline or NUL after the last delimiter line,
 * NULL if the text ends inside a body.
 */
static const char *skip_heredocs(const char *p, char delims[][DELIM_MAX],
                                 const int *strip, int n)
{
    int i;

    for (i = 0; i < n; i++) {
        size_t want = strlen(delims[i]);
        for (;;) {
            const char *line, *end;
            if (*p != '\n')
                return NULL;
            line = p + 1;
            end = strchr(line, '\n');
            if (end == NULL)
                end = line + strlen(line);
            p = end;
            if (strip[i])
                while (*line == '\t')
                    line++;
            if ((size_t)(end - line) == want &&
                strncmp(line, delims[i], want) == 0)
                break;
        }
    }
    return p;
}

/* The first heavy simple command in a Bash command string, else K_NONE. */
static enum kind heavy_command(const char *cmd, struct match *m)
{
    static struct words s;      /* 8 KiB, kept off the stack */
    char delims[MAX_HEREDOCS][DELIM_MAX], scratch[DELIM_MAX];
    int strip[MAX_HEREDOCS], nhd = 0, scratch_strip;
    enum { PLAIN, SINGLE, DOUBLE } q = PLAIN;
    const char *p;

    s.n = s.len = s.open = s.skip = 0;
    for (p = cmd; *p != '\0'; p++) {
        char c = *p;

        if (q == SINGLE) {
            if (c == '\'')
                q = PLAIN;
            else
                put(&s, c);
            continue;
        }
        if (q == DOUBLE) {
            if (c == '"') {
                q = PLAIN;
            } else if (c == '\\' && p[1] != '\0' &&
                       strchr("\"\\$`\n", p[1]) != NULL) {
                if (p[1] != '\n')
                    put(&s, p[1]);
                p++;
            } else {
                put(&s, c);
            }
            continue;
        }
        switch (c) {
        case '\'':
            q = SINGLE;
            begin(&s);
            break;
        case '"':
            q = DOUBLE;
            begin(&s);
            break;
        case '\\':
            if (p[1] == '\n')
                p++;                    /* line continuation */
            else if (p[1] != '\0')
                put(&s, *++p);
            break;
        case ' ':
        case '\t':
        case '\r':
            end_word(&s);
            break;
        case '#':
            if (s.open) {
                put(&s, c);
                break;
            }
            while (p[1] != '\0' && p[1] != '\n')
                p++;                    /* comment */
            break;
        case '<':
            if (p[1] == '<' && p[2] != '<') {
                end_word(&s);
                if (nhd < MAX_HEREDOCS) {
                    p = heredoc_start(p, delims[nhd], &strip[nhd]);
                    if (delims[nhd][0] != '\0')
                        nhd++;
                } else {
                    p = heredoc_start(p, scratch, &scratch_strip);
                }
                break;
            }
            /* fall through */
        case '>':
            end_word(&s);               /* <, >, >>, >|, >&, <&, <<<, <> */
            while (p[1] == '<' || p[1] == '>' || p[1] == '&' || p[1] == '|')
                p++;
            s.skip = 1;
            break;
        case '&':
            if (p[1] == '>') {          /* &>, &>> */
                end_word(&s);
                while (p[1] == '>')
                    p++;
                s.skip = 1;
                break;
            }
            /* fall through */
        case '\n':
        case ';':
        case '|':
        case '(':
        case ')':
        case '`':
            if (end_command(&s, m) != K_NONE)
                return m->kind;
            if (c == '\n' && nhd > 0) {
                p = skip_heredocs(p, delims, strip, nhd);
                nhd = 0;
                if (p == NULL || *p == '\0')
                    return K_NONE;
            }
            break;
        default:
            put(&s, c);
        }
    }
    return end_command(&s, m);
}

/* ------------------------------------------------------------------------
 * The Bash call behind a running shell (k15). One reading for the watcher,
 * which learns the command, and the slot scan, which finds it running.
 */

static const char *const SHELLS[] = {"bash", "sh", "dash", "zsh", NULL};

enum harness {
    H_ANY,          /* the slot scan: Claude Code's wrapper, else Codex's */
    H_CLAUDE,       /* only Claude Code's wrapper */
    H_CODEX         /* only Codex's plain string */
};

/*
 * The eval text of Claude Code's wrapper around a Bash call, on the heap;
 * NULL if s is not that wrapper. Recorded with 2.1.283
 * (t/fixtures/shells/claude-code.json):
 *
 *   source <snapshot> … || true && eval '<command>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd
 *
 * The command is one single-quoted word, a quote inside it written as
 * '"'"'; " < /dev/null" is left out when the command has a heredoc or a
 * stdin redirection of its own. The word is read as the shell reads it —
 * '…' literally, "…" with \" \\ \$ \` \<newline>, \x outside quotes — so
 * the '\'' spelling reads as well. Anything the shell would expand or split
 * ($ or ` in double quotes, any other unquoted character) and any other
 * ending is not the wrapper.
 */
static char *claude_eval(const char *s)
{
    const char *p = s, *q;
    char *out, *o;

    while ((p = strstr(p, "eval ")) != NULL && p != s && p[-1] != ' ')
        p++;
    if (p == NULL || (out = malloc(strlen(p) + 1)) == NULL)
        return NULL;
    o = out;
    for (p += 5; *p != '\0' && *p != ' ';) {
        if (*p == '\'') {
            if ((q = strchr(p + 1, '\'')) == NULL)
                goto unknown;
            memcpy(o, p + 1, (size_t)(q - p - 1));
            o += q - p - 1;
            p = q + 1;
        } else if (*p == '"') {
            for (p++; *p != '"'; p++) {
                if (*p == '\0' || *p == '$' || *p == '`')
                    goto unknown;
                if (*p == '\\' && p[1] != '\0' &&
                    strchr("\"\\$`\n", p[1]) != NULL) {
                    p++;
                    if (*p == '\n')
                        continue;           /* line continuation */
                }
                *o++ = *p;
            }
            p++;
        } else if (*p == '\\' && p[1] != '\0') {
            if (p[1] != '\n')
                *o++ = p[1];
            p += 2;
        } else {
            goto unknown;
        }
    }
    *o = '\0';
    if (strncmp(p, " < /dev/null", 12) == 0)
        p += 12;
    if (strncmp(p, " && pwd -P >| ", 14) != 0)
        goto unknown;
    p += 14;
    q = p + strcspn(p, " \t\n'\"\\$`;&|<>()");
    if (*q == '\0' && q - p > 4 && strcmp(q - 4, "-cwd") == 0)
        return out;
unknown:
    free(out);
    return NULL;
}

/*
 * The command a running `<shell> -c|-lc <string>` executes, on the heap;
 * NULL if argv is no such shell or the string is not of the harness's
 * form. Claude Code: the eval text of its wrapper. Codex: the string
 * itself — codex-rs runs `<shell> -c|-lc <command>`, with its shell
 * snapshot as a script that execs exactly that (core/src/shell.rs:22-31,
 * tools/runtimes/mod.rs:225-302); confirmed live 2026-09-27, argv[2] the
 * model's command byte for byte (k16, t/fixtures/shells/codex.json).
 */
static char *shell_command(char *const *av, int ac, enum harness h)
{
    char *cmd = NULL;

    if (ac < 3 || !one_of(base(av[0]), SHELLS) ||
        (strcmp(av[1], "-c") != 0 && strcmp(av[1], "-lc") != 0))
        return NULL;
    if (h != H_CODEX)
        cmd = claude_eval(av[2]);
    if (cmd == NULL && h != H_CLAUDE)
        cmd = strdup(av[2]);
    return cmd;
}

/* The NUL-separated args of a cmdline into av; trailing empty ones dropped. */
static int split_argv(char *buf, ssize_t len, char **av, int max)
{
    char *p;
    int ac = 0;

    for (p = buf; p < buf + len && ac < max; p += strlen(p) + 1)
        av[ac++] = p;
    while (ac > 1 && av[ac - 1][0] == '\0')
        ac--;
    return ac;
}

/* ------------------------------------------------------------------------
 * Measurement. `root` prefixes every path; it is "" in production and a
 * fixture tree in the test driver.
 */

/* The file root+path into buf, NUL-terminated; its length, or -1. */
static ssize_t slurp(const char *root, const char *path, char *buf,
                     size_t size)
{
    char full[PATH_MAX];
    ssize_t total = 0;
    int fd;

    if (snprintf(full, sizeof full, "%s%s", root, path) >= (int)sizeof full)
        return -1;
    fd = open(full, O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return -1;
    while ((size_t)total < size - 1) {
        ssize_t r = read(fd, buf + total, size - 1 - (size_t)total);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            close(fd);
            return -1;
        }
        if (r == 0)
            break;
        total += r;
    }
    close(fd);
    buf[total] = '\0';
    return total;
}

/* A decimal number at s (leading blanks allowed) into *out. */
static int number(const char *s, unsigned long long *out)
{
    char *end;

    while (*s == ' ' || *s == '\t')
        s++;
    if (!isdigit((unsigned char)*s))
        return 0;
    errno = 0;
    *out = strtoull(s, &end, 10);
    return errno == 0;
}

/* The kB figure of a /proc/meminfo key ("SwapFree:") at a line start. */
static int meminfo(const char *buf, const char *key, unsigned long long *out)
{
    size_t n = strlen(key);
    const char *p = buf;

    while ((p = strstr(p, key)) != NULL) {
        if (p == buf || p[-1] == '\n')
            return number(p + n, out);
        p += n;
    }
    return 0;
}

struct pressure {
    double full;        /* memory PSI full avg10 in %, -1: unknown */
    int swap;           /* all swap used in %, -1: unknown or no swap */
};

/* The avg10 figure of a PSI line ("full avg10=") in %, -1 if missing. */
static double avg10(const char *buf, const char *key)
{
    const char *p = strstr(buf, key);
    char *end;
    double v;

    if (p == NULL)
        return -1;
    p += strlen(key);
    v = strtod(p, &end);
    return end != p && v >= 0 && v <= 100 ? v : -1;
}

static void read_pressure(const char *root, struct pressure *pr)
{
    char buf[8192];
    unsigned long long total, avail;

    pr->full = -1;
    pr->swap = -1;
    if (slurp(root, "/proc/pressure/memory", buf, sizeof buf) > 0)
        pr->full = avg10(buf, "full avg10=");
    if (slurp(root, "/proc/meminfo", buf, sizeof buf) > 0 &&
        meminfo(buf, "SwapTotal:", &total) &&
        meminfo(buf, "SwapFree:", &avail) && total > 0 && avail <= total)
        pr->swap = (int)((total - avail) * 100 / total);
}

/* Data stored in all zram devices, % of their size; -1 if none. Info only. */
static int zram_fill(const char *root)
{
    char path[PATH_MAX], buf[256];
    unsigned long long size = 0, data = 0, s, d;
    struct dirent *e;
    DIR *dir;

    if (snprintf(path, sizeof path, "%s/sys/block", root) >= (int)sizeof path)
        return -1;
    dir = opendir(path);
    if (dir == NULL)
        return -1;
    while ((e = readdir(dir)) != NULL) {
        if (strncmp(e->d_name, "zram", 4) != 0)
            continue;
        snprintf(path, sizeof path, "/sys/block/%s/disksize", e->d_name);
        if (slurp(root, path, buf, sizeof buf) <= 0 || !number(buf, &s) ||
            s == 0)
            continue;           /* never initialised */
        snprintf(path, sizeof path, "/sys/block/%s/mm_stat", e->d_name);
        if (slurp(root, path, buf, sizeof buf) <= 0 || !number(buf, &d))
            continue;
        size += s;
        data += d;
    }
    closedir(dir);
    return size ? (int)(data * 100 / size) : -1;
}

/* ------------------------------------------------------------------------
 * The learned list (k15): read by the hook and the slot scan, written by
 * the watcher (below) and by `loadguard forget` (lib/loadguard/learn.py),
 * both under flock on learned.lock, each write a new file renamed over the
 * old one.
 */

#define LEARNED_FILE "learned.jsonl"
#define LEARNED_LOCK "learned.lock"
#define LEARNED_BYTES ((size_t)1 << 20)   /* larger: ignored, as if empty */
#define LEARNED_LINES 256                  /* lines read at most */
#define LEARNED_MAX 100                    /* entries the watcher keeps */
#define LEARN_COMMAND_MAX 4096             /* longer commands are not learned */
#define LEARN_RSS_DEFAULT 20               /* % of MemTotal */

enum { LS_OFF, LS_NONE, LS_OK, LS_TOO_LARGE, LS_UNREADABLE };
static const char *const LEARN_STATES[] = {
    "off", "none", "ok", "too-large", "unreadable"
};

struct lesson {
    char *command;
    double peak;                /* bytes, -1 unknown */
    char last[11];              /* date last seen big, "" unknown */
};

static struct {
    int loaded, state, n;
    struct lesson l[LEARNED_LINES];
} lessons;

/* LOADGUARD_LEARN=0, only that exact value: no watcher, list ignored. */
static int learn_off(void)
{
    const char *off = getenv("LOADGUARD_LEARN");
    return off != NULL && strcmp(off, "0") == 0;
}

/* ${XDG_STATE_HOME:-$HOME/.local/state}/loadguard/<name>; 0 without an
 * absolute path for either (the XDG spec ignores a relative one). */
static int state_file(char *out, size_t size, const char *name)
{
    const char *xdg = getenv("XDG_STATE_HOME"), *home = getenv("HOME");
    int n;

    if (xdg != NULL && xdg[0] == '/')
        n = snprintf(out, size, "%s/loadguard/%s", xdg, name);
    else if (home != NULL && home[0] == '/')
        n = snprintf(out, size, "%s/.local/state/loadguard/%s", home, name);
    else
        return 0;
    return n > 0 && (size_t)n < size;
}

/*
 * A regular file of at most max bytes, NUL-terminated, on the heap, its
 * length in *len; else NULL and why in *state. O_NONBLOCK and the fstat
 * keep a FIFO planted in its place from blocking the hook.
 */
static char *read_regular(const char *path, size_t max, size_t *len,
                          int *state)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY);
    struct stat st;
    char *buf = NULL;
    size_t n = 0;

    *state = LS_UNREADABLE;
    if (fd < 0) {
        if (errno == ENOENT)
            *state = LS_NONE;
        return NULL;
    }
    if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
        if ((size_t)st.st_size > max)
            *state = LS_TOO_LARGE;
        else
            buf = malloc((size_t)st.st_size + 1);
    }
    while (buf != NULL && n < (size_t)st.st_size) {
        ssize_t r = read(fd, buf + n, (size_t)st.st_size - n);
        if (r < 0 && errno == EINTR)
            continue;
        if (r < 0) {
            free(buf);
            buf = NULL;
        } else if (r == 0) {
            break;
        } else {
            n += (size_t)r;
        }
    }
    close(fd);
    if (buf != NULL) {
        buf[n] = '\0';
        *len = n;
        *state = LS_OK;
    }
    return buf;
}

/* One line of the list as a JSON object with a string "command", or NULL. */
static cJSON *parse_lesson(const char *line, size_t n)
{
    const char *end = NULL;
    cJSON *o = cJSON_ParseWithLengthOpts(line, n, &end, 0);

    if (o == NULL)
        return NULL;
    while (end != NULL && end < line + n && isspace((unsigned char)*end))
        end++;
    if (end != line + n || !cJSON_IsObject(o) ||
        !cJSON_IsString(cJSON_GetObjectItemCaseSensitive(o, "command"))) {
        cJSON_Delete(o);
        return NULL;
    }
    return o;
}

/* Each object line of a list text, at most LEARNED_LINES; for each, fn. */
static void each_lesson(const char *buf, size_t len,
                        void (*fn)(cJSON *, void *), void *arg)
{
    const char *line, *end;
    int lines = 0;

    for (line = buf; line < buf + len && lines < LEARNED_LINES;
         line = end + 1, lines++) {
        cJSON *o;
        end = memchr(line, '\n', (size_t)(buf + len - line));
        if (end == NULL)
            end = buf + len;
        if ((o = parse_lesson(line, (size_t)(end - line))) != NULL)
            fn(o, arg);
    }
}

static void keep_lesson(cJSON *o, void *unused)
{
    const cJSON *peak = cJSON_GetObjectItemCaseSensitive(o, "peak_rss");
    const cJSON *last = cJSON_GetObjectItemCaseSensitive(o, "last_seen");
    struct lesson *ls = &lessons.l[lessons.n];
    const char *d;
    int i;

    (void)unused;
    ls->command = strdup(cJSON_GetObjectItemCaseSensitive(o, "command")
                             ->valuestring);
    if (ls->command != NULL) {
        ls->peak = cJSON_IsNumber(peak) && peak->valuedouble > 0
                       ? peak->valuedouble : -1;
        /* The date goes into a reason: only YYYY-MM-DD. */
        ls->last[0] = '\0';
        if (cJSON_IsString(last) && strlen(d = last->valuestring) >= 10) {
            for (i = 0; i < 10; i++)
                if (i == 4 || i == 7 ? d[i] != '-'
                                     : !isdigit((unsigned char)d[i]))
                    break;
            if (i == 10)
                snprintf(ls->last, sizeof ls->last, "%.10s", d);
        }
        lessons.n++;
    }
    cJSON_Delete(o);
}

/* The list, read once per run; nothing while learning is off. */
static void load_lessons(void)
{
    char path[PATH_MAX], *buf;
    size_t len;

    if (lessons.loaded)
        return;
    lessons.loaded = 1;
    lessons.state = LS_OFF;
    if (learn_off())
        return;
    lessons.state = LS_NONE;
    if (!state_file(path, sizeof path, LEARNED_FILE))
        return;
    buf = read_regular(path, LEARNED_BYTES, &len, &lessons.state);
    if (buf == NULL)
        return;
    each_lesson(buf, len, keep_lesson, NULL);
    free(buf);
}

static const struct lesson *lesson_for(const char *command)
{
    int i;

    load_lessons();
    for (i = 0; i < lessons.n; i++)
        if (strcmp(lessons.l[i].command, command) == 0)
            return &lessons.l[i];
    return NULL;
}

/* "3.2 GiB", "640 MiB" */
static void human_size(double bytes, char *out, size_t size)
{
    if (bytes >= 1073741824.0)
        snprintf(out, size, "%.1f GiB", bytes / 1073741824.0);
    else
        snprintf(out, size, "%.0f MiB", bytes / 1048576.0);
}

/* "learned: peaked at 3.2 GiB RSS on 2026-09-21" */
static void lesson_label(const struct lesson *ls, char *label, size_t size)
{
    char peak[32];
    size_t n;

    snprintf(label, size, "learned");
    if (ls->peak > 0) {
        human_size(ls->peak, peak, sizeof peak);
        n = strlen(label);
        snprintf(label + n, size - n, ": peaked at %s RSS", peak);
    }
    if (ls->last[0] != '\0') {
        n = strlen(label);
        snprintf(label + n, size - n, " on %s", ls->last);
    }
}

/* s into out, cut to fit with "..." at a character boundary. */
static void cut(char *out, size_t size, const char *s)
{
    size_t n = strlen(s);

    if (n < size) {
        memcpy(out, s, n + 1);
        return;
    }
    n = size - 4;
    while (n > 0 && ((unsigned char)s[n] & 0xC0) == 0x80)
        n--;
    memcpy(out, s, n);
    strcpy(out + n, "...");
}

/* ------------------------------------------------------------------------
 * Heavy slots: one pass over /proc, processes under app-loadguard.slice.
 */

#define SHOWN 3                 /* holders named in a reason */
#define MAX_DEPTH 64            /* ancestors followed */

struct proc {
    int pid, ppid;
    enum kind kind;
    char label[48];             /* "prove -lr t/" */
};

struct slots {
    int busy;
    int shown;
    char holder[SHOWN][160];    /* "prove -lr t/ in ~/dev/sunriser" */
};

/* Bytes a reason must not carry: controls, and non-ASCII unless UTF-8. */
static void sanitize(char *s)
{
    int utf8 = valid_utf8((const unsigned char *)s, strlen(s));

    for (; *s != '\0'; s++)
        if ((unsigned char)*s < 0x20 || *s == 0x7f ||
            ((unsigned char)*s >= 0x80 && !utf8))
            *s = '?';
}

static int read_ppid(const char *root, int pid, int *ppid)
{
    char path[64], buf[1024], *p;

    snprintf(path, sizeof path, "/proc/%d/stat", pid);
    if (slurp(root, path, buf, sizeof buf) <= 0)
        return 0;
    /* comm may hold spaces and parens: the fields follow the last ')'. */
    p = strrchr(buf, ')');
    return p != NULL && sscanf(p + 1, " %*c %d", ppid) == 1;
}

/*
 * K_LEARNED if argv is a shell running a command of the learned list; the
 * command, cut to fit, in label. Nothing is extracted while the list is
 * empty.
 */
static enum kind learned_shell(char *const *av, int ac, char *label,
                               size_t size)
{
    char *cmd;
    int found;

    load_lessons();
    if (lessons.n == 0 || (cmd = shell_command(av, ac, H_ANY)) == NULL)
        return K_NONE;
    found = lesson_for(cmd) != NULL;
    if (found)
        cut(label, size, cmd);
    free(cmd);
    return found ? K_LEARNED : K_NONE;
}

/* The kind of a running process by its argv; its short command in label. */
static enum kind process_kind(const char *root, int pid, char *label,
                              size_t size)
{
    /* Room for a wrapper around a learned command of the longest kind. */
    static char buf[1 << 16];
    char path[64], *av[MAX_WORDS];
    struct match m;
    ssize_t len;
    int ac, i;

    snprintf(path, sizeof path, "/proc/%d/cmdline", pid);
    len = slurp(root, path, buf, sizeof buf);
    if (len <= 0)
        return K_NONE;          /* gone, a zombie, a kernel thread */
    ac = split_argv(buf, len, av, MAX_WORDS);
    /* A process title (npm: "npm test", padded with NULs) is one string. */
    if (ac == 1 && strchr(av[0], ' ') != NULL) {
        char *save, *w;
        ac = 0;
        for (w = strtok_r(av[0], " ", &save); w != NULL && ac < MAX_WORDS;
             w = strtok_r(NULL, " ", &save))
            av[ac++] = w;
    }
    if (classify(av, ac, &m) == K_NONE)
        /* A cut-off cmdline has lost the wrapper's ending. */
        return (size_t)len < sizeof buf - 1 ? learned_shell(av, ac, label,
                                                            size)
                                            : K_NONE;
    snprintf(label, size, "%s", base(av[m.at]));
    for (i = m.at + 1; i < ac; i++) {
        size_t used = strlen(label);
        if (used + 1 + strlen(av[i]) >= size) {
            if (used + 4 < size)
                strcat(label, " ...");
            break;
        }
        label[used] = ' ';
        strcpy(label + used + 1, av[i]);
    }
    return m.kind;
}

static int by_pid(const void *a, const void *b)
{
    int x = ((const struct proc *)a)->pid, y = ((const struct proc *)b)->pid;
    return (x > y) - (x < y);
}

static const struct proc *find(const struct proc *ps, size_t n, int pid)
{
    struct proc key;
    key.pid = pid;
    return bsearch(&key, ps, n, sizeof *ps, by_pid);
}

static int holds_slot(enum kind k)
{
    return k != K_NONE && k != K_AGENT;
}

/* Is a slot-holding process above p, within the slice? */
static int heavy_above(const struct proc *ps, size_t n, const struct proc *p)
{
    int depth;

    for (depth = 0; depth < MAX_DEPTH; depth++) {
        p = find(ps, n, p->ppid);
        if (p == NULL)
            return 0;
        if (holds_slot(p->kind))
            return 1;
    }
    return 0;
}

/* "prove -lr t/ in ~/dev/sunriser" */
static void describe(const char *root, const struct proc *p, char *out,
                     size_t size)
{
    char path[PATH_MAX], cwd[PATH_MAX];
    const char *home = getenv("HOME"), *where = cwd;
    size_t hl = home ? strlen(home) : 0;
    ssize_t n;

    if (snprintf(path, sizeof path, "%s/proc/%d/cwd", root, p->pid) >=
        (int)sizeof path ||
        (n = readlink(path, cwd, sizeof cwd - 1)) <= 0) {
        snprintf(out, size, "%s", p->label);
    } else {
        cwd[n] = '\0';
        if (hl > 1 && strncmp(cwd, home, hl) == 0 &&
            (cwd[hl] == '/' || cwd[hl] == '\0')) {
            where = cwd + hl - 1;
            cwd[hl - 1] = '~';
        }
        if (snprintf(out, size, "%s in %s", p->label, where) >= (int)size &&
            size > 4)
            strcpy(out + size - 4, "...");
    }
    sanitize(out);
}

static void scan_slots(const char *root, struct slots *sl)
{
    char path[PATH_MAX], buf[4096];
    struct proc *ps = NULL;
    size_t n = 0, cap = 0, i;
    struct dirent *e;
    DIR *dir;

    sl->busy = sl->shown = 0;
    if (snprintf(path, sizeof path, "%s/proc", root) >= (int)sizeof path)
        return;
    dir = opendir(path);
    if (dir == NULL)
        return;
    while ((e = readdir(dir)) != NULL) {
        char *end;
        long pid = strtol(e->d_name, &end, 10);

        if (!isdigit((unsigned char)e->d_name[0]) || *end != '\0' ||
            pid <= 0 || pid > INT_MAX)
            continue;
        snprintf(path, sizeof path, "/proc/%ld/cgroup", pid);
        if (slurp(root, path, buf, sizeof buf) <= 0 ||
            strstr(buf, "/" SLICE "/") == NULL)
            continue;
        if (n == cap) {
            struct proc *more = realloc(ps, (cap ? cap * 2 : 64) * sizeof *ps);
            if (more == NULL)
                break;
            ps = more;
            cap = cap ? cap * 2 : 64;
        }
        ps[n].pid = (int)pid;
        if (!read_ppid(root, ps[n].pid, &ps[n].ppid))
            continue;
        ps[n].kind = process_kind(root, ps[n].pid, ps[n].label,
                                  sizeof ps[n].label);
        n++;
    }
    closedir(dir);
    if (n > 0)
        qsort(ps, n, sizeof *ps, by_pid);
    for (i = 0; i < n; i++) {
        if (!holds_slot(ps[i].kind) || heavy_above(ps, n, &ps[i]))
            continue;
        if (sl->shown < SHOWN)
            describe(root, &ps[i], sl->holder[sl->shown++],
                     sizeof sl->holder[0]);
        sl->busy++;
    }
    free(ps);
}

/* ------------------------------------------------------------------------
 * The decision.
 */

struct config {
    int psi_full, swap_used, slots;
};

/* An integer from the environment (a trailing % allowed), else def. */
static int env_int(const char *name, int def, int lo, int hi)
{
    const char *s = getenv(name);
    long v = 0;

    if (s == NULL || !isdigit((unsigned char)*s))
        return def;
    for (; isdigit((unsigned char)*s); s++)
        if ((v = v * 10 + (*s - '0')) > hi)
            return def;
    if (*s == '%')
        s++;
    return *s == '\0' && v >= lo ? (int)v : def;
}

/* The tunable limits; the reports list the ones set but invalid. */
enum { L_PSI_FULL, L_SWAP_USED, L_SLOTS, L_LEARN_RSS, N_LIMITS };

static const struct {
    const char *env;
    int lo, hi;
} LIMITS[N_LIMITS] = {
    [L_PSI_FULL] = {"LOADGUARD_PSI_FULL", 1, 100},
    [L_SWAP_USED] = {"LOADGUARD_SWAP_USED", 1, 100},
    [L_SLOTS] = {"LOADGUARD_HEAVY_SLOTS", 1, 4096},
    [L_LEARN_RSS] = {"LOADGUARD_LEARN_RSS", 1, 100},
};

static int limit(int which, int def)
{
    return env_int(LIMITS[which].env, def, LIMITS[which].lo, LIMITS[which].hi);
}

/* LOADGUARD_THROTTLE=0, only that exact value: pure pass-through. */
static int throttle_off(void)
{
    const char *off = getenv("LOADGUARD_THROTTLE");
    return off != NULL && strcmp(off, "0") == 0;
}

/* max(1, nproc / 2), nproc as `nproc` counts: the CPUs we may run on. */
static int default_slots(void)
{
    cpu_set_t set;
    long n = -1;

    if (sched_getaffinity(0, sizeof set, &set) == 0)
        n = CPU_COUNT(&set);
    if (n < 1)
        n = sysconf(_SC_NPROCESSORS_ONLN);
    return n >= 2 ? (int)(n / 2) : 1;
}

__attribute__((format(printf, 3, 4)))
static void add(char *buf, size_t size, const char *fmt, ...)
{
    size_t len = strlen(buf);
    va_list ap;

    if (len + 1 >= size)
        return;
    va_start(ap, fmt);
    vsnprintf(buf + len, size - len, fmt, ap);
    va_end(ap);
}

/* "memory pressure full=59.9% (limit 10%), swap 100% used (limit 90%)" */
static void pressure_figures(char *r, size_t size, const struct pressure *pr,
                             const struct config *c)
{
    if (pr->full >= 0)
        add(r, size, "memory pressure full=%.1f%% (limit %d%%)", pr->full,
            c->psi_full);
    else
        add(r, size, "memory pressure n/a");
    if (pr->swap >= 0)
        add(r, size, ", swap %d%% used (limit %d%%)", pr->swap, c->swap_used);
}

static void measures(char *r, size_t size, const char *root,
                     const struct pressure *pr, const struct config *c)
{
    int zram = zram_fill(root);

    pressure_figures(r, size, pr, c);
    if (zram >= 0)
        add(r, size, ", zram %d%% full", zram);
    add(r, size, ".\n");
}

/*
 * Under memory pressure no test run is advised, not even a small one: any
 * run adds memory, one perl can take the box (the 3.8 GB one-liner,
 * 20260917-175030), and naming a command the classifier lets through would
 * teach the way around the guard. With full slots, a smaller run is advice
 * for the retry — it is heavy too and needs a slot.
 */
static void advice(char *r, size_t size, const struct match *m, int slots)
{
    add(r, size, "%s; light commands (git status, ls, cat) still run.",
        slots ? "Wait for one to finish, then retry"
              : "Wait and retry later");
    switch (m->kind) {
    case K_PROVE:
        if (slots)
            add(r, size, " When you retry, run fewer tests: "
                "`prove -l t/foo.t` instead of `-r`.");
        break;
    case K_SUITE:
        if (slots)
            add(r, size, " When you retry, run a single test file instead "
                "of the whole suite.");
        break;
    case K_AGENT:
        add(r, size, " Do not start new `claude -p`/`claude --bg` or "
            "`codex exec`/`codex review` sessions now; do the work in this "
            "one.");
        break;
    default:
        break;
    }
}

/*
 * What the decision found out, as far as it got. The hook uses only the
 * answer; the report modes print the rest.
 */
struct verdict {
    int off;                /* LOADGUARD_THROTTLE=0: nothing looked at */
    struct match m;         /* m.kind K_NONE: light, only the list read */
    int pressured;          /* no_room() ran: c, pr set; pr at a limit */
    int scanned;            /* no_room() found no pressure: c.slots, sl set */
    struct config c;
    struct pressure pr;
    struct slots sl;
};

/*
 * Memory under pressure: PSI full avg10 or all swap used at its limit. Two
 * kernel files, no process. The first half of no_room(), and all the
 * context line (k6) asks.
 */
static int under_pressure(const char *root, struct verdict *v)
{
    v->c.psi_full = limit(L_PSI_FULL, PSI_FULL_DEFAULT);
    v->c.swap_used = limit(L_SWAP_USED, SWAP_USED_DEFAULT);
    read_pressure(root, &v->pr);
    v->scanned = 0;
    v->pressured = v->pr.full >= v->c.psi_full || v->pr.swap >= v->c.swap_used;
    return v->pressured;
}

/*
 * The heavy path: is the host out of room for one more heavy command?
 * Memory first; only without pressure the slot scan, which reads other
 * processes.
 */
static int no_room(const char *root, struct verdict *v)
{
    if (under_pressure(root, v))
        return 1;
    v->c.slots = limit(L_SLOTS, default_slots());
    scan_slots(root, &v->sl);
    v->scanned = 1;
    return v->sl.busy >= v->c.slots;
}

/* Is the exact command in the learned list? Then heavy, labelled with its
 * peak and date. */
static int learned_command(const char *command, struct match *m)
{
    const struct lesson *ls = lesson_for(command);

    if (ls == NULL)
        return 0;
    m->kind = K_LEARNED;
    m->at = 0;
    lesson_label(ls, m->label, sizeof m->label);
    return 1;
}

/*
 * Did Codex send this payload (k14)? Codex adds turn_id to its turn-scoped
 * hook inputs, PreToolUse and UserPromptSubmit among them (codex-rs
 * rust-v0.153.4 hooks/src/schema.rs:280-281, 569-570, "Codex extension");
 * Claude Code's carry none. SessionStart has no turn_id and no field of
 * Codex's own (schema.rs:499-510), so there the environment tells: Codex
 * sets PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT to the same path for every hook
 * of a plugin (hooks/src/engine/discovery.rs:262-270) — and only as a
 * plugin does loadguard run under Codex — while Claude Code sets
 * CLAUDE_PLUGIN_ROOT alone. No file is read. A wrong answer costs a period
 * or a pointer, nothing else.
 */
static int from_codex(const cJSON *payload, const char *event)
{
    const char *root, *claude_root;

    if (event == NULL || strcmp(event, "SessionStart") != 0)
        return cJSON_IsString(
            cJSON_GetObjectItemCaseSensitive(payload, "turn_id"));
    root = getenv("PLUGIN_ROOT");
    claude_root = getenv("CLAUDE_PLUGIN_ROOT");
    return root != NULL && claude_root != NULL &&
           strcmp(root, claude_root) == 0;
}

/*
 * The deny reason for a Bash command into reason; 0 if loadguard has no
 * objection. Light commands return having read the learned list only.
 * For Codex without the final period: it appends ". Command: <cmd>"
 * (core/src/hook_runtime.rs:229-234), and the model read "still run..".
 */
static int objection(const char *root, const char *command, int codex,
                     struct verdict *v, char *reason, size_t size)
{
    size_t n;
    int i;

    v->m.kind = K_NONE;
    v->pressured = v->scanned = 0;
    v->off = throttle_off();
    if (v->off || (heavy_command(command, &v->m) == K_NONE &&
                   !learned_command(command, &v->m)))
        return 0;
    if (!no_room(root, v))
        return 0;

    reason[0] = '\0';
    add(reason, size, "loadguard: heavy command refused (%s): ", v->m.label);
    if (v->scanned) {
        add(reason, size, "%d/%d heavy slots busy (", v->sl.busy, v->c.slots);
        for (i = 0; i < v->sl.shown; i++)
            add(reason, size, "%s%s", i ? "; " : "", v->sl.holder[i]);
        if (v->sl.busy > v->sl.shown)
            add(reason, size, "; +%d more", v->sl.busy - v->sl.shown);
        add(reason, size, "), ");
    }
    measures(reason, size, root, &v->pr, &v->c);
    advice(reason, size, &v->m, v->scanned);
    if (codex && (n = strlen(reason)) > 0 && reason[n - 1] == '.')
        reason[n - 1] = '\0';
    return 1;
}

/*
 * Stage 4 (k6): the events whose context gets the line. Both take
 * hookSpecificOutput.additionalContext into the model's context (hooks
 * docs): UserPromptSubmit next to the prompt, SessionStart before the first.
 */
static const char *const CONTEXT_EVENTS[] = {
    "UserPromptSubmit", "SessionStart", NULL
};

/* The hook_event_name of a payload that may get the line, else NULL. */
static const char *context_event(const cJSON *payload)
{
    const cJSON *name;

    if (!cJSON_IsObject(payload))
        return NULL;
    name = cJSON_GetObjectItemCaseSensitive(payload, "hook_event_name");
    return cJSON_IsString(name) && one_of(name->valuestring, CONTEXT_EVENTS)
               ? name->valuestring
               : NULL;
}

/*
 * The context line into line; 0 unless memory is under pressure — the test
 * the heavy path makes first, so the line shows exactly while pressure alone
 * refuses heavy commands. Full slots alone add no line: the host is fine and
 * a slot frees in a moment. No test run is suggested (see advice()). Facts,
 * not orders: the hooks docs warn that text framed as system instructions
 * can trip prompt-injection defenses. For Codex without the pointer to
 * `loadguard status`: Codex puts no plugin bin/ on its shell's PATH
 * (core/src/tools/runtimes/mod.rs:118-144), and in its sandbox /proc shows
 * the sandbox alone.
 */
static int situation(const char *root, int codex, struct verdict *v,
                     char *line, size_t size)
{
    v->pressured = v->scanned = 0;
    v->off = throttle_off();
    if (v->off || !under_pressure(root, v))
        return 0;

    line[0] = '\0';
    add(line, size, "loadguard: ");
    pressure_figures(line, size, &v->pr, &v->c);
    add(line, size, ". Heavy commands refused until it eases: prove, make "
        "test, builds, new claude -p/--bg. Light commands still run%s.",
        codex ? "" : "; see `loadguard status`");
    return 1;
}

/*
 * The longest reason is about 920 bytes (a label of < 64, 3 holders of
 * < 160, all figures at 100 %, the longest advice), the context line 216 at
 * most: neither ever gets cut, and so never mid-character.
 */
#define REASON_MAX 1024

/*
 * {"hookSpecificOutput": {key: value, …}} on stdout from NULL-terminated
 * key/value pairs, hookEventName first; nothing if it cannot be built. No
 * other top-level key: Codex (k11) rejects unknown ones.
 */
static void respond(const char *const *kv)
{
    cJSON *out = cJSON_CreateObject(), *hso = NULL;
    char *text = NULL;

    if (out != NULL &&
        (hso = cJSON_AddObjectToObject(out, "hookSpecificOutput")) != NULL) {
        for (; kv[0] != NULL; kv += 2)
            if (cJSON_AddStringToObject(hso, kv[0], kv[1]) == NULL)
                break;
        if (kv[0] == NULL)
            text = cJSON_PrintUnformatted(out);
    }
    if (text != NULL) {
        /* No newline: the form recorded working in k7. */
        fputs(text, stdout);
        cJSON_free(text);
    }
    cJSON_Delete(out);
}

/*
 * One payload: on UserPromptSubmit/SessionStart the context line or
 * nothing; else, for Bash, the documented PreToolUse deny or nothing.
 */
static void hook(const char *root, const cJSON *payload)
{
    const char *event = context_event(payload);
    const cJSON *input;
    char text[REASON_MAX];
    struct verdict v;

    if (event != NULL) {
        if (situation(root, from_codex(payload, event), &v, text,
                      sizeof text)) {
            const char *const kv[] = {
                "hookEventName", event, "additionalContext", text, NULL
            };
            respond(kv);
        }
        return;
    }
    input = bash_tool_input(payload);
    if (input != NULL &&
        objection(root,
                  cJSON_GetObjectItemCaseSensitive(input, "command")->valuestring,
                  from_codex(payload, NULL), &v, text, sizeof text)) {
        const char *const kv[] = {
            "hookEventName", "PreToolUse", "permissionDecision", "deny",
            "permissionDecisionReason", text, NULL
        };
        respond(kv);
    }
}

/* ------------------------------------------------------------------------
 * Report modes for bin/loadguard (k5): what objection() and no_room() found,
 * as one line of JSON. Figures no decision uses (PSI some, zram) are read
 * here, after the fact.
 */

#define REPORT_FORMAT 1

/* A percentage, or null where the source gave none (-1). */
static void put_percent(cJSON *o, const char *key, double v)
{
    if (v >= 0)
        cJSON_AddNumberToObject(o, key, v);
    else
        cJSON_AddNullToObject(o, key);
}

/* Memory PSI some avg10 in %, -1 if unknown. Info: the hook uses full. */
static double psi_some(const char *root)
{
    char buf[8192];

    if (slurp(root, "/proc/pressure/memory", buf, sizeof buf) <= 0)
        return -1;
    return avg10(buf, "some avg10=");
}

/* The common head; "ignored": variables set that change nothing. */
static cJSON *report_start(const char *mode, int off)
{
    cJSON *out = cJSON_CreateObject(), *ignored;
    int i;

    cJSON_AddNumberToObject(out, "report", REPORT_FORMAT);
    cJSON_AddStringToObject(out, "mode", mode);
    cJSON_AddBoolToObject(out, "throttle", !off);
    ignored = cJSON_AddArrayToObject(out, "ignored");
    if (getenv("LOADGUARD_THROTTLE") != NULL && !off)
        cJSON_AddItemToArray(ignored,
                             cJSON_CreateString("LOADGUARD_THROTTLE"));
    for (i = 0; i < N_LIMITS; i++)
        if (getenv(LIMITS[i].env) != NULL && limit(i, -1) < 0)
            cJSON_AddItemToArray(ignored, cJSON_CreateString(LIMITS[i].env));
    if (getenv("LOADGUARD_LEARN") != NULL && !learn_off())
        cJSON_AddItemToArray(ignored, cJSON_CreateString("LOADGUARD_LEARN"));
    return out;
}

/* The learned list as the hook reads it (k15). */
static void put_learn(cJSON *out)
{
    cJSON *o = cJSON_AddObjectToObject(out, "learn");
    char path[PATH_MAX];

    load_lessons();
    cJSON_AddBoolToObject(o, "on", !learn_off());
    if (state_file(path, sizeof path, LEARNED_FILE))
        cJSON_AddStringToObject(o, "file", path);
    else
        cJSON_AddNullToObject(o, "file");
    cJSON_AddStringToObject(o, "state", LEARN_STATES[lessons.state]);
    cJSON_AddNumberToObject(o, "entries", lessons.n);
    cJSON_AddNumberToObject(o, "rss_limit",
                            limit(L_LEARN_RSS, LEARN_RSS_DEFAULT));
}

/* What no_room() measured: limits, pressure, and the slots if scanned. */
static void put_room(cJSON *out, const char *root, const struct verdict *v,
                     int slot_limit)
{
    cJSON *o = cJSON_AddObjectToObject(out, "limits"), *holders;
    int i;

    cJSON_AddNumberToObject(o, "psi_full", v->c.psi_full);
    cJSON_AddNumberToObject(o, "swap_used", v->c.swap_used);
    if (slot_limit)
        cJSON_AddNumberToObject(o, "slots", v->c.slots);
    o = cJSON_AddObjectToObject(out, "pressure");
    put_percent(o, "full", v->pr.full);
    put_percent(o, "some", psi_some(root));
    put_percent(o, "swap", v->pr.swap);
    put_percent(o, "zram", zram_fill(root));
    cJSON_AddBoolToObject(out, "pressured", v->pressured);
    if (!v->scanned) {
        cJSON_AddNullToObject(out, "slots");
        return;
    }
    o = cJSON_AddObjectToObject(out, "slots");
    cJSON_AddNumberToObject(o, "busy", v->sl.busy);
    holders = cJSON_AddArrayToObject(o, "holders");
    for (i = 0; i < v->sl.shown; i++)
        cJSON_AddItemToArray(holders, cJSON_CreateString(v->sl.holder[i]));
}

/* One line on stdout; 1 if it could not be built. */
static int report_print(cJSON *out)
{
    char *text = cJSON_PrintUnformatted(out);
    int rc = text != NULL && puts(text) >= 0 ? 0 : 1;

    cJSON_free(text);
    cJSON_Delete(out);
    return rc;
}

/* --report: the host as the heavy path sees it right now. */
static int report_status(const char *root)
{
    struct verdict v;
    cJSON *out;
    int full;

    v.off = throttle_off();
    full = no_room(root, &v);
    if (!v.scanned)
        v.c.slots = limit(L_SLOTS, default_slots());
    out = report_start("status", v.off);
    put_room(out, root, &v, 1);
    cJSON_AddBoolToObject(out, "refuse_heavy", !v.off && full);
    put_learn(out);
    return report_print(out);
}

/* --explain: the hook's answer to one payload and what it looked at. */
static int report_explain(const char *root, const cJSON *payload)
{
    const cJSON *input = bash_tool_input(payload);
    char reason[REASON_MAX];
    struct verdict v;
    int denied = 0;
    cJSON *out;

    if (input == NULL) {
        out = report_start("explain", throttle_off());
        cJSON_AddBoolToObject(out, "bash", 0);
    } else {
        denied = objection(root, cJSON_GetObjectItemCaseSensitive(
                               input, "command")->valuestring,
                           from_codex(payload, NULL), &v, reason,
                           sizeof reason);
        out = report_start("explain", v.off);
        cJSON_AddBoolToObject(out, "bash", 1);
        if (v.m.kind == K_NONE)
            cJSON_AddNullToObject(out, "heavy");
        else
            cJSON_AddStringToObject(out, "heavy", v.m.label);
        if (!v.off && v.m.kind != K_NONE)
            put_room(out, root, &v, v.scanned);
    }
    cJSON_AddStringToObject(out, "decision", denied ? "deny" : "allow");
    if (denied)
        cJSON_AddStringToObject(out, "reason", reason);
    else
        cJSON_AddNullToObject(out, "reason");
    return report_print(out);
}

/* ------------------------------------------------------------------------
 * The watcher (k15): `--watch PID`, one per session scope. Every TICK_S it
 * reads the scope's cgroup.procs and, per process, /proc/<pid>/stat and
 * statm — kernel counters, no page of the process is touched — and sums
 * the RSS below each Bash call: the topmost `<shell> -c|-lc` under the
 * session process. A call at LOADGUARD_LEARN_RSS % of MemTotal is written
 * to the list at once (a thrash reboot mid-command must not lose it), again
 * when its peak grew by 10 %, and once when its shell ends. Its cmdline is
 * read once, when it first crosses the limit. RSS, not PSS: smaps_rollup
 * walks the page tables and can hang under thrash.
 *
 * It never keeps the scope alive: it ends as soon as the session process is
 * gone (or its scope, or its start time changed: a reused PID). It never
 * spins: every pass ends in a TICK_S sleep. Anything it cannot read counts
 * as nothing; it prints nothing.
 */

#define TICK_S 2
#define RUNS 16                 /* calls over the limit tracked at once */

struct wproc {
    int pid, ppid, shell;
    unsigned long long start, rss, sum;
};

struct run {                    /* a Bash call over the limit */
    int pid, learning;          /* learning 0: not learned, cmdline read */
    unsigned long long start, peak, written;
    char *command;
    char cwd[PATH_MAX];
};

struct watch {
    const char *root;
    int session, self;
    unsigned long long since;   /* the session process's start time */
    enum harness harness;
    char procs[PATH_MAX];       /* the scope's cgroup.procs */
    unsigned long long limit;   /* bytes */
    unsigned long long page;
    int nrun;
    struct run run[RUNS];
};

/* The test driver logs what the watcher does; production does not. */
static FILE *watch_log;
static int watch_pass;

static void log_run(const char *event, const struct run *r, const char *why)
{
    cJSON *o;
    char *text;

    if (watch_log == NULL || (o = cJSON_CreateObject()) == NULL)
        return;
    cJSON_AddNumberToObject(o, "tick", watch_pass);
    cJSON_AddStringToObject(o, "event", event);
    cJSON_AddNumberToObject(o, "pid", r->pid);
    cJSON_AddNumberToObject(o, "peak", (double)r->peak);
    if (r->command != NULL)
        cJSON_AddStringToObject(o, "command", r->command);
    if (why != NULL)
        cJSON_AddStringToObject(o, "why", why);
    if ((text = cJSON_PrintUnformatted(o)) != NULL) {
        fprintf(watch_log, "%s\n", text);
        cJSON_free(text);
    }
    cJSON_Delete(o);
}

/* comm (may be NULL), ppid and start time from /proc/<pid>/stat. */
static int read_stat(const char *root, int pid, char *comm, size_t size,
                     int *ppid, unsigned long long *start)
{
    char path[64], buf[1024], *open_paren, *close_paren;

    snprintf(path, sizeof path, "/proc/%d/stat", pid);
    if (slurp(root, path, buf, sizeof buf) <= 0 ||
        (open_paren = strchr(buf, '(')) == NULL ||
        (close_paren = strrchr(buf, ')')) == NULL)
        return 0;
    if (comm != NULL)
        snprintf(comm, size, "%.*s", (int)(close_paren - open_paren - 1),
                 open_paren + 1);
    /* state ppid, 17 fields, starttime (proc(5): fields 3, 4, 22) */
    return sscanf(close_paren + 1,
                  " %*c %d %*s %*s %*s %*s %*s %*s %*s %*s %*s %*s %*s %*s "
                  "%*s %*s %*s %*s %*s %llu", ppid, start) == 2;
}

/* Resident bytes from /proc/<pid>/statm. */
static int read_rss(const struct watch *w, int pid, unsigned long long *rss)
{
    char path[64], buf[256];
    unsigned long long pages;

    snprintf(path, sizeof path, "/proc/%d/statm", pid);
    if (slurp(w->root, path, buf, sizeof buf) <= 0 ||
        sscanf(buf, "%*s %llu", &pages) != 1)
        return 0;
    *rss = pages * w->page;
    return 1;
}

/* Claude Code or Codex by comm or argv[0], as confine.py's session_name. */
static enum harness harness_of(const char *root, int pid, const char *comm)
{
    char path[64], buf[4096];
    const char *name = comm;

    if (strcmp(name, "claude") != 0 && strcmp(name, "codex") != 0) {
        snprintf(path, sizeof path, "/proc/%d/cmdline", pid);
        if (slurp(root, path, buf, sizeof buf) <= 0)
            return H_ANY;
        name = base(buf);
    }
    return strcmp(name, "claude") == 0 ? H_CLAUDE
         : strcmp(name, "codex") == 0  ? H_CODEX : H_ANY;
}

/*
 * The loadguard-*.scope pid is in: its cgroup.procs below /sys/fs/cgroup
 * into procs, its name into name.
 */
static int scope_of(const char *root, int pid, char *procs, size_t psize,
                    char *name, size_t nsize)
{
    char path[64], buf[4096], *p, *nl, *slash;
    size_t n;

    snprintf(path, sizeof path, "/proc/%d/cgroup", pid);
    if (slurp(root, path, buf, sizeof buf) <= 0)
        return 0;
    for (p = buf; p != NULL && strncmp(p, "0::", 3) != 0;
         p = (nl = strchr(p, '\n')) != NULL ? nl + 1 : NULL)
        ;
    if (p == NULL)
        return 0;
    if ((nl = strchr(p, '\n')) != NULL)
        *nl = '\0';
    slash = strrchr(p, '/');
    if (slash == NULL || strncmp(slash + 1, "loadguard-", 10) != 0 ||
        (n = strlen(slash + 1)) <= 16 || strcmp(slash + n - 5, ".scope") != 0)
        return 0;
    return snprintf(procs, psize, "/sys/fs/cgroup%s/cgroup.procs", p + 3) <
               (int)psize &&
           snprintf(name, nsize, "%s", slash + 1) < (int)nsize;
}

/* Every missing directory above file, mode 0700; 0 if the last fails. */
static int make_dirs(const char *file)
{
    char dir[PATH_MAX], *s;

    if (snprintf(dir, sizeof dir, "%s", file) >= (int)sizeof dir ||
        (s = strrchr(dir, '/')) == NULL || s == dir)
        return 0;
    *s = '\0';
    for (s = dir + 1; *s != '\0'; s++)
        if (*s == '/') {
            *s = '\0';
            mkdir(dir, 0700);
            *s = '/';
        }
    return mkdir(dir, 0700) == 0 || errno == EEXIST;
}

/* Replace the object's key, or add it. */
static void set_item(cJSON *o, const char *key, cJSON *item)
{
    if (item == NULL)
        return;
    if (cJSON_GetObjectItemCaseSensitive(o, key) != NULL)
        cJSON_ReplaceItemInObjectCaseSensitive(o, key, item);
    else
        cJSON_AddItemToObject(o, key, item);
}

static void add_to_array(cJSON *o, void *array)
{
    cJSON_AddItemToArray(array, o);
}

static const char *last_seen(const cJSON *o)
{
    const cJSON *last = cJSON_GetObjectItemCaseSensitive(o, "last_seen");
    return cJSON_IsString(last) ? last->valuestring : "";
}

/* The whole list into path.<pid>.tmp, synced, renamed over path. */
static void write_lessons(const char *path, const cJSON *all)
{
    char tmp[PATH_MAX + 32], dir[PATH_MAX], *slash;
    const cJSON *o;
    FILE *f;
    int ok = 1, fd;

    if (snprintf(tmp, sizeof tmp, "%s.%d.tmp", path, (int)getpid()) >=
            (int)sizeof tmp ||
        (fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600)) < 0)
        return;
    if ((f = fdopen(fd, "w")) == NULL) {
        close(fd);
        unlink(tmp);
        return;
    }
    cJSON_ArrayForEach(o, all) {
        char *text = cJSON_PrintUnformatted(o);
        ok = ok && text != NULL && fprintf(f, "%s\n", text) > 0;
        cJSON_free(text);
    }
    ok = fflush(f) == 0 && ok && fsync(fileno(f)) == 0;
    if (fclose(f) != 0 || !ok || rename(tmp, path) != 0) {
        unlink(tmp);
        return;
    }
    snprintf(dir, sizeof dir, "%s", path);
    if ((slash = strrchr(dir, '/')) != NULL && slash != dir) {
        *slash = '\0';
        if ((fd = open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC)) >= 0) {
            fsync(fd);
            close(fd);
        }
    }
}

/*
 * Record a run in the list under flock: its peak (the highest ever seen
 * for the command), cwd and last_seen; first_seen when new. Above
 * LEARNED_MAX entries the one longest not seen big goes. An oversized or
 * broken list is replaced; lines that are no entry are dropped.
 */
static void learned_update(const struct run *r, time_t now)
{
    char path[PATH_MAX], lock_path[PATH_MAX], stamp[32], *buf;
    cJSON *all, *hit = NULL, *o;
    const cJSON *peak;
    struct tm tm;
    size_t len;
    int lock, state;

    if (!state_file(path, sizeof path, LEARNED_FILE) ||
        !state_file(lock_path, sizeof lock_path, LEARNED_LOCK) ||
        !make_dirs(lock_path) ||
        (lock = open(lock_path, O_RDWR | O_CREAT | O_CLOEXEC, 0600)) < 0)
        return;
    if (flock(lock, LOCK_EX) != 0 || (all = cJSON_CreateArray()) == NULL) {
        close(lock);
        return;
    }
    if ((buf = read_regular(path, LEARNED_BYTES, &len, &state)) != NULL) {
        each_lesson(buf, len, add_to_array, all);
        free(buf);
    }
    gmtime_r(&now, &tm);
    strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%SZ", &tm);
    cJSON_ArrayForEach(o, all)
        if (strcmp(cJSON_GetObjectItemCaseSensitive(o, "command")
                       ->valuestring, r->command) == 0) {
            hit = o;
            break;
        }
    if (hit == NULL && (hit = cJSON_CreateObject()) != NULL) {
        cJSON_AddStringToObject(hit, "command", r->command);
        cJSON_AddItemToArray(all, hit);
    }
    if (hit != NULL) {
        peak = cJSON_GetObjectItemCaseSensitive(hit, "peak_rss");
        set_item(hit, "peak_rss", cJSON_CreateNumber(
            cJSON_IsNumber(peak) && peak->valuedouble > (double)r->peak
                ? peak->valuedouble : (double)r->peak));
        set_item(hit, "cwd", cJSON_CreateString(r->cwd));
        if (cJSON_GetObjectItemCaseSensitive(hit, "first_seen") == NULL)
            set_item(hit, "first_seen", cJSON_CreateString(stamp));
        set_item(hit, "last_seen", cJSON_CreateString(stamp));
    }
    while (cJSON_GetArraySize(all) > LEARNED_MAX) {
        cJSON *oldest = NULL;
        cJSON_ArrayForEach(o, all)
            if (oldest == NULL || strcmp(last_seen(o), last_seen(oldest)) < 0)
                oldest = o;
        cJSON_Delete(cJSON_DetachItemViaPointer(all, oldest));
    }
    write_lessons(path, all);
    cJSON_Delete(all);
    close(lock);                /* releases the flock */
}

static void record(struct run *r, time_t now, const char *event)
{
    learned_update(r, now);
    r->written = r->peak;
    log_run(event, r, NULL);
}

/*
 * The command of a shell over the limit, on the heap, or NULL (why says
 * why): its cmdline is read here, once. Not learned: a form the harness
 * does not use, an empty, overlong or non-UTF-8 command, one the fixed
 * list calls heavy already.
 */
static char *run_command(const struct watch *w, int pid, const char **why)
{
    static char buf[1 << 18];
    char path[64], *av[MAX_WORDS], *cmd;
    struct match m;
    ssize_t len;
    size_t n;

    snprintf(path, sizeof path, "/proc/%d/cmdline", pid);
    len = slurp(w->root, path, buf, sizeof buf);
    if (len <= 0 || (size_t)len >= sizeof buf - 1) {
        *why = "cmdline";
        return NULL;
    }
    cmd = shell_command(av, split_argv(buf, len, av, MAX_WORDS), w->harness);
    if (cmd == NULL) {
        *why = "form";
        return NULL;
    }
    n = strlen(cmd);
    if (n == 0 || n > LEARN_COMMAND_MAX ||
        !valid_utf8((const unsigned char *)cmd, n))
        *why = "text";
    else if (heavy_command(cmd, &m) != K_NONE)
        *why = "fixed";
    else
        return cmd;
    free(cmd);
    return NULL;
}

static void start_run(struct watch *w, const struct wproc *sh, time_t now)
{
    char path[64];
    const char *why = "full";
    struct run *r, spill;
    ssize_t n;

    if (w->nrun == RUNS) {
        memset(&spill, 0, sizeof spill);
        spill.pid = sh->pid;
        spill.peak = sh->sum;
        log_run("skip", &spill, why);
        return;
    }
    r = &w->run[w->nrun++];
    memset(r, 0, sizeof *r);
    r->pid = sh->pid;
    r->start = sh->start;
    r->peak = sh->sum;
    if ((r->command = run_command(w, sh->pid, &why)) == NULL) {
        log_run("skip", r, why);
        return;
    }
    snprintf(path, sizeof path, "%s/proc/%d/cwd", w->root, sh->pid);
    n = readlink(path, r->cwd, sizeof r->cwd - 1);
    r->cwd[n > 0 ? n : 0] = '\0';
    sanitize(r->cwd);
    r->learning = 1;
    record(r, now, "learn");
}

/* The last word on a run whose shell ended; frees it. */
static void end_run(struct watch *w, int i, time_t now)
{
    struct run *r = &w->run[i];

    if (r->learning)
        record(r, now, "end");
    free(r->command);
    *r = w->run[--w->nrun];
}

static int by_wpid(const void *a, const void *b)
{
    int x = ((const struct wproc *)a)->pid, y = ((const struct wproc *)b)->pid;
    return (x > y) - (x < y);
}

static struct wproc *find_w(struct wproc *ps, size_t n, int pid)
{
    struct wproc key;
    key.pid = pid;
    return bsearch(&key, ps, n, sizeof *ps, by_wpid);
}

/* The topmost shell between p and the session process; NULL if none, or if
 * p is not below the session (an orphan whose shell is gone). */
static struct wproc *top_shell(struct wproc *ps, size_t n, struct wproc *p,
                               int session)
{
    struct wproc *top = NULL;
    int depth;

    for (depth = 0; depth < MAX_DEPTH && p->pid != session; depth++) {
        if (p->shell)
            top = p;
        if (p->ppid == session)
            return top;
        if ((p = find_w(ps, n, p->ppid)) == NULL)
            return NULL;
    }
    return NULL;
}

/* One look at the scope; 0 once the session process is gone. */
static int watch_tick(struct watch *w, time_t now)
{
    static char buf[1 << 16];
    static struct wproc *ps;
    static size_t cap;
    unsigned long long start;
    char comm[64], *p, *end;
    size_t n = 0, i;
    int ppid, j;

    if (!read_stat(w->root, w->session, NULL, 0, &ppid, &start) ||
        start != w->since || slurp(w->root, w->procs, buf, sizeof buf) < 0) {
        while (w->nrun > 0)
            end_run(w, w->nrun - 1, now);
        return 0;
    }
    for (p = buf;; p = end) {
        long pid = strtol(p, &end, 10);
        if (end == p)
            break;
        if (pid <= 0 || pid > INT_MAX || pid == w->self)
            continue;
        if (n == cap) {
            struct wproc *more = realloc(ps, (cap ? cap * 2 : 64) * sizeof *ps);
            if (more == NULL)
                break;
            ps = more;
            cap = cap ? cap * 2 : 64;
        }
        ps[n].pid = (int)pid;
        if (!read_stat(w->root, ps[n].pid, comm, sizeof comm, &ps[n].ppid,
                       &ps[n].start) ||
            !read_rss(w, ps[n].pid, &ps[n].rss))
            continue;               /* gone meanwhile */
        ps[n].shell = one_of(comm, SHELLS);
        ps[n].sum = 0;
        n++;
    }
    if (n > 0)
        qsort(ps, n, sizeof *ps, by_wpid);
    for (i = 0; i < n; i++) {
        struct wproc *top = top_shell(ps, n, &ps[i], w->session);
        if (top != NULL)
            top->sum += ps[i].rss;
    }
    for (j = w->nrun - 1; j >= 0; j--) {
        struct run *r = &w->run[j];
        struct wproc *sh = find_w(ps, n, r->pid);
        if (sh == NULL || sh->start != r->start) {
            end_run(w, j, now);
            continue;
        }
        if (sh->sum > r->peak)
            r->peak = sh->sum;
        if (r->learning && r->peak >= r->written + r->written / 10)
            record(r, now, "grow");
    }
    for (i = 0; i < n; i++) {
        if (!ps[i].shell || ps[i].sum < w->limit)
            continue;
        for (j = 0; j < w->nrun; j++)
            if (w->run[j].pid == ps[i].pid &&
                w->run[j].start == ps[i].start)
                break;
        if (j == w->nrun)
            start_run(w, &ps[i], now);
    }
    return 1;
}

/* The scope PID was confined in, the harness, the limit; 0 if any is
 * missing: then there is nothing to watch. */
static int watch_setup(struct watch *w, const char *root, int pid,
                       char *scope, size_t size)
{
    char comm[64], buf[8192];
    unsigned long long total;
    long page = sysconf(_SC_PAGESIZE);
    int ppid;

    memset(w, 0, sizeof *w);
    w->root = root;
    w->session = pid;
    w->self = (int)getpid();
    w->page = page > 0 ? (unsigned long long)page : 4096;
    if (!read_stat(root, pid, comm, sizeof comm, &ppid, &w->since) ||
        (w->harness = harness_of(root, pid, comm)) == H_ANY ||
        !scope_of(root, pid, w->procs, sizeof w->procs, scope, size) ||
        slurp(root, "/proc/meminfo", buf, sizeof buf) <= 0 ||
        !meminfo(buf, "MemTotal:", &total) || total == 0)
        return 0;
    w->limit = total * 1024 / 100 * (unsigned long long)limit(
        L_LEARN_RSS, LEARN_RSS_DEFAULT);
    return 1;
}

/*
 * One watcher per scope: flock on $XDG_RUNTIME_DIR/loadguard/<scope>.watch,
 * which holds its pid (for doctor). -1 if another holds it or there is no
 * runtime dir: a resumed session, a nested claude -p, an app-server
 * thread find the scope watched already.
 */
static int watch_lock(const char *scope, char *path, size_t size)
{
    const char *run = getenv("XDG_RUNTIME_DIR");
    char pid[32];
    int fd, n;

    if (run == NULL || run[0] != '/' ||
        snprintf(path, size, "%s/loadguard/%s.watch", run, scope) >=
            (int)size ||
        !make_dirs(path) ||
        (fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600)) < 0)
        return -1;
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        close(fd);
        return -1;
    }
    n = snprintf(pid, sizeof pid, "%d\n", (int)getpid());
    if (ftruncate(fd, 0) != 0 || write(fd, pid, (size_t)n) != n) {
        /* doctor will not find it; the lock still holds */
    }
    return fd;
}

static void watch_free(struct watch *w)
{
    while (w->nrun > 0)
        free(w->run[--w->nrun].command);
}

#ifndef LOADGUARD_TEST

/* --watch PID: until the session process is gone. */
static int watch(const char *arg)
{
    char scope[256], lock[PATH_MAX], *end;
    long pid = strtol(arg, &end, 10);
    struct timespec pause;
    struct watch w;
    int fd;

    if (*arg == '\0' || *end != '\0' || pid <= 1 || pid > INT_MAX ||
        learn_off() || chdir("/") != 0)
        return 0;
    setpriority(PRIO_PROCESS, 0, 10);
    if (!watch_setup(&w, "", (int)pid, scope, sizeof scope) ||
        (fd = watch_lock(scope, lock, sizeof lock)) < 0)
        return 0;
    while (watch_tick(&w, time(NULL))) {
        pause.tv_sec = TICK_S;
        pause.tv_nsec = 0;
        while (nanosleep(&pause, &pause) != 0 && errno == EINTR)
            ;
    }
    unlink(lock);
    close(fd);
    watch_free(&w);
    return 0;
}

static void note(const char *why)
{
    fprintf(stderr, "loadguard: pass-through (%s)\n", why);
}

static int blank(const char *s, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++)
        if (s[i] != ' ' && s[i] != '\t' && s[i] != '\n' && s[i] != '\r')
            return 0;
    return 1;
}

int main(int argc, char **argv)
{
    int explain = argc == 2 && strcmp(argv[1], "--explain") == 0;
    size_t len = 0;
    char *buf;
    cJSON *payload;

    /* A closed stdout must not kill the hook: exit 0 all the same. */
    signal(SIGPIPE, SIG_IGN);
    if (argc == 2 && strcmp(argv[1], "--report") == 0)
        return report_status("");
    if (argc == 3 && strcmp(argv[1], "--watch") == 0)
        return watch(argv[2]);
    buf = read_stdin(&len);
    if (explain) {
        int rc;
        payload = buf != NULL ? parse_payload(buf, len) : NULL;
        free(buf);
        rc = report_explain("", payload);
        cJSON_Delete(payload);
        return rc;
    }
    if (buf == NULL) {
        note("stdin unreadable or too large");
        return 0;
    }
    if (blank(buf, len)) {
        free(buf);
        return 0;
    }
    payload = parse_payload(buf, len);
    free(buf);
    if (payload == NULL) {
        note("payload is not UTF-8 JSON");
        return 0;
    }
    hook("", payload);
    cJSON_Delete(payload);
    return 0;
}

#else /* LOADGUARD_TEST */

/*
 * Test driver, payload on stdin (a Bash payload unless noted):
 *   command        print tool_input.command verbatim
 *   heavy          print the label of the first heavy simple command, or
 *                  nothing
 *   measure ROOT   any payload: "full=%.2f swap=%d zram=%d" below ROOT
 *   slots ROOT     any payload: busy count, then one holder per line
 *   decide ROOT    any payload: exactly what the hook prints (deny, context
 *                  line or nothing), with /proc and /sys below ROOT
 *   report ROOT    any payload: what --report prints, below ROOT
 *   explain ROOT   any payload: what --explain prints, below ROOT
 *   extract        {"argv": [...], "harness": "claude"|"codex"|"any"}: the
 *                  command the shell runs, as the watcher and the slot scan
 *                  read it; nothing and exit 1 if there is none
 *   watch SESSION ROOT...
 *                  any payload: the watcher, one pass per ROOT (no sleep;
 *                  the clock is LOADGUARD_TEST_NOW, default 1790000000,
 *                  plus TICK_S per pass); one JSON line per thing it does,
 *                  then {"watch": done|gone|locked|no-scope}
 * Exit 1 if a Bash payload is needed and missing, 64 on usage.
 */

static int driver_extract(const cJSON *payload)
{
    const cJSON *args = cJSON_GetObjectItemCaseSensitive(payload, "argv");
    const cJSON *h = cJSON_GetObjectItemCaseSensitive(payload, "harness");
    char *av[MAX_WORDS], *cmd;
    const cJSON *a;
    int ac = 0;

    cJSON_ArrayForEach(a, args)
        if (cJSON_IsString(a) && ac < MAX_WORDS)
            av[ac++] = a->valuestring;
    cmd = shell_command(av, ac,
        !cJSON_IsString(h) ? H_ANY
        : strcmp(h->valuestring, "claude") == 0 ? H_CLAUDE
        : strcmp(h->valuestring, "codex") == 0 ? H_CODEX : H_ANY);
    if (cmd == NULL)
        return 1;
    fputs(cmd, stdout);
    free(cmd);
    return 0;
}

static int driver_watch(const char *arg, char **roots, int nroots)
{
    const char *now = getenv("LOADGUARD_TEST_NOW"), *status = "done";
    time_t base = now != NULL ? (time_t)strtoll(now, NULL, 10) : 1790000000;
    char scope[256] = "", lock[PATH_MAX], *end;
    long pid = strtol(arg, &end, 10);
    struct watch w;
    int fd, i;

    memset(&w, 0, sizeof w);
    watch_log = stdout;
    if (*end != '\0' || pid <= 0 || pid > INT_MAX ||
        !watch_setup(&w, roots[0], (int)pid, scope, sizeof scope)) {
        status = "no-scope";
    } else if ((fd = watch_lock(scope, lock, sizeof lock)) < 0) {
        status = "locked";
    } else {
        for (i = 0; i < nroots; i++) {
            w.root = roots[i];
            watch_pass = i + 1;
            if (!watch_tick(&w, base + (time_t)TICK_S * i)) {
                status = "gone";
                break;
            }
        }
        unlink(lock);
        close(fd);
    }
    watch_free(&w);
    printf("{\"watch\":\"%s\"}\n", status);
    return 0;
}

int main(int argc, char **argv)
{
    size_t len = 0;
    char *buf = read_stdin(&len);
    cJSON *payload = buf ? parse_payload(buf, len) : NULL;
    const cJSON *input = bash_tool_input(payload);
    const char *mode = argc >= 2 ? argv[1] : "";
    const char *command = input ? cJSON_GetObjectItemCaseSensitive(
        input, "command")->valuestring : NULL;
    int rc = 0;

    free(buf);
    if (argc == 2 && strcmp(mode, "command") == 0 && command) {
        fputs(command, stdout);
    } else if (argc == 2 && strcmp(mode, "heavy") == 0 && command) {
        struct match m;
        if (heavy_command(command, &m) != K_NONE)
            fputs(m.label, stdout);
    } else if (argc == 3 && strcmp(mode, "measure") == 0) {
        struct pressure pr;
        read_pressure(argv[2], &pr);
        printf("full=%.2f swap=%d zram=%d", pr.full, pr.swap,
               zram_fill(argv[2]));
    } else if (argc == 3 && strcmp(mode, "slots") == 0) {
        struct slots sl;
        int i;
        scan_slots(argv[2], &sl);
        printf("%d\n", sl.busy);
        for (i = 0; i < sl.shown; i++)
            printf("%s\n", sl.holder[i]);
    } else if (argc == 3 && strcmp(mode, "decide") == 0) {
        hook(argv[2], payload);
    } else if (argc == 3 && strcmp(mode, "report") == 0) {
        rc = report_status(argv[2]);
    } else if (argc == 3 && strcmp(mode, "explain") == 0) {
        rc = report_explain(argv[2], payload);
    } else if (argc == 2 && strcmp(mode, "extract") == 0) {
        rc = driver_extract(payload);
    } else if (argc >= 4 && strcmp(mode, "watch") == 0) {
        rc = driver_watch(argv[2], argv + 3, argc - 3);
    } else if (argc == 2 && (strcmp(mode, "command") == 0 ||
                             strcmp(mode, "heavy") == 0)) {
        rc = 1;
    } else {
        rc = input != NULL ? 64 : 1;
    }
    cJSON_Delete(payload);
    return rc;
}

#endif
