/*
 * loadguard-hook — PreToolUse hook on Bash, the compiled path (k8, k4).
 *
 * Silent (no stdout, exit 0: the command runs as is) unless the command is
 * heavy and the host has no room for it. Then it prints the documented deny
 * JSON, whose reason Claude Code hands to the model — still exit 0.
 *
 * Heavy: a simple command of the Bash string — at its start, after ; & | ( )
 * ` or a newline, past VAR=x assignments and prefixes like nice, timeout or
 * env — runs prove, dzil test|build|release, make … test, cpanm,
 * docker|podman build|run, cargo build|test, npm test, perlbench or
 * claude -p|--print|--bg. Quotes, comments and heredoc bodies are not
 * commands. Everything else is light and costs no read beyond stdin.
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
 *     make). claude -p/--bg sessions hold no slot; what they run does.
 * LOADGUARD_THROTTLE=0 (only that exact value): pure pass-through.
 *
 * Fail open: whatever goes wrong (empty or oversized stdin, not UTF-8, broken
 * JSON, missing fields, out of memory) ends in exit 0 with nothing on stdout.
 * An unreadable measurement counts as room: no PSI, no swap figure, no /proc
 * entry — no objection from that source. Never exit 2: that is the only
 * code with which a hook blocks regardless of its output.
 *
 * Cheap: no fork, no exec, no file other than stdin on the light path. JSON
 * only via the vendored cJSON (vendor/cJSON/) — commands carry escapes,
 * heredocs, Unicode.
 *
 * Commands are never rewritten (k3): confinement is per session, done on
 * SessionStart (hooks/loadguard-confine). This hook only stays silent or
 * denies.
 *
 * Hook mode is any call but the two below; hooks/loadguard execs the binary
 * without arguments. For bin/loadguard (k5) there are two read-only report
 * modes, one line of JSON on stdout each:
 *   --report     the host as the heavy path sees it: limits, pressure, slots
 *                (not scanned under pressure, as in the hook); reads no stdin
 *   --explain    a hook payload on stdin: the hook's answer and what it
 *                measured on the way
 * Both run objection() and no_room(), the functions the hook runs; nothing
 * in them decides on its own.
 *
 * Built with -DLOADGUARD_TEST, main() is swapped for a test driver that
 * exposes the extraction, the matcher, the measurement, the decision and the
 * reports against a fixture root (t/test_hook_binary.py, t/test_throttle.py);
 * the production binary reads the real /proc and has no test mode.
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
    K_CLAUDE        /* claude -p|--print|--bg: heavy to start, holds no slot */
};

struct match {
    enum kind kind;
    int at;             /* index of the command word in the argv judged */
    char label[32];     /* "prove", "make test", "podman run", … */
};

static const char *const INTERPRETERS[] = {
    "perl", "python", "python3", "node", "sh", "bash", "dash", NULL
};

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
    } else if (strcmp(name, "claude") == 0) {
        for (i = 1; i < ac && kind == K_NONE; i++)
            if (strcmp(av[i], "-p") == 0 || strcmp(av[i], "--print") == 0 ||
                strcmp(av[i], "--bg") == 0) {
                kind = K_CLAUDE;
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

/* The kind of a running process by its argv; its short command in label. */
static enum kind process_kind(const char *root, int pid, char *label,
                              size_t size)
{
    char path[64], buf[4096], *av[MAX_WORDS];
    struct match m;
    ssize_t len;
    int ac = 0, i;
    char *p;

    snprintf(path, sizeof path, "/proc/%d/cmdline", pid);
    len = slurp(root, path, buf, sizeof buf);
    if (len <= 0)
        return K_NONE;          /* gone, a zombie, a kernel thread */
    for (p = buf; p < buf + len && ac < MAX_WORDS; p += strlen(p) + 1)
        av[ac++] = p;
    while (ac > 1 && av[ac - 1][0] == '\0')
        ac--;
    /* A process title (npm: "npm test", padded with NULs) is one string. */
    if (ac == 1 && strchr(av[0], ' ') != NULL) {
        char *save, *w;
        ac = 0;
        for (w = strtok_r(av[0], " ", &save); w != NULL && ac < MAX_WORDS;
             w = strtok_r(NULL, " ", &save))
            av[ac++] = w;
    }
    if (classify(av, ac, &m) == K_NONE)
        return K_NONE;
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
    return k != K_NONE && k != K_CLAUDE;
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
enum { L_PSI_FULL, L_SWAP_USED, L_SLOTS, N_LIMITS };

static const struct {
    const char *env;
    int lo, hi;
} LIMITS[N_LIMITS] = {
    [L_PSI_FULL] = {"LOADGUARD_PSI_FULL", 1, 100},
    [L_SWAP_USED] = {"LOADGUARD_SWAP_USED", 1, 100},
    [L_SLOTS] = {"LOADGUARD_HEAVY_SLOTS", 1, 4096},
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

static void measures(char *r, size_t size, const char *root,
                     const struct pressure *pr, const struct config *c)
{
    int zram = zram_fill(root);

    if (pr->full >= 0)
        add(r, size, "memory pressure full=%.1f%% (limit %d%%)", pr->full,
            c->psi_full);
    else
        add(r, size, "memory pressure n/a");
    if (pr->swap >= 0)
        add(r, size, ", swap %d%% used (limit %d%%)", pr->swap, c->swap_used);
    if (zram >= 0)
        add(r, size, ", zram %d%% full", zram);
    add(r, size, ".\n");
}

static void advice(char *r, size_t size, const struct match *m, int slots)
{
    add(r, size, "%s; light commands (git status, ls, cat) still run.",
        slots ? "Wait for one to finish, then retry"
              : "Wait and retry later");
    switch (m->kind) {
    case K_PROVE:
        add(r, size, " Or run fewer tests at once: `prove -l t/foo.t` "
            "instead of `-r`.");
        break;
    case K_SUITE:
        add(r, size, " Or run a single test file instead of the whole "
            "suite.");
        break;
    case K_CLAUDE:
        add(r, size, " Do not start new `claude -p`/`claude --bg` sessions "
            "now; do the work in this one.");
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
    struct match m;         /* m.kind K_NONE: light, nothing read */
    int pressured;          /* no_room() ran: c, pr set; pr at a limit */
    int scanned;            /* no_room() found no pressure: c.slots, sl set */
    struct config c;
    struct pressure pr;
    struct slots sl;
};

/*
 * The heavy path: is the host out of room for one more heavy command?
 * Memory first; only without pressure the slot scan, which reads other
 * processes.
 */
static int no_room(const char *root, struct verdict *v)
{
    v->c.psi_full = limit(L_PSI_FULL, PSI_FULL_DEFAULT);
    v->c.swap_used = limit(L_SWAP_USED, SWAP_USED_DEFAULT);
    read_pressure(root, &v->pr);
    v->scanned = 0;
    v->pressured = v->pr.full >= v->c.psi_full || v->pr.swap >= v->c.swap_used;
    if (v->pressured)
        return 1;
    v->c.slots = limit(L_SLOTS, default_slots());
    scan_slots(root, &v->sl);
    v->scanned = 1;
    return v->sl.busy >= v->c.slots;
}

/*
 * The deny reason for a Bash command into reason; 0 if loadguard has no
 * objection. Light commands return before any read.
 */
static int objection(const char *root, const char *command, struct verdict *v,
                     char *reason, size_t size)
{
    int i;

    v->m.kind = K_NONE;
    v->pressured = v->scanned = 0;
    v->off = throttle_off();
    if (v->off || heavy_command(command, &v->m) == K_NONE)
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
    return 1;
}

/*
 * The longest reason is about 850 bytes (3 holders of < 160, all figures at
 * 100 %, the longest advice): it never gets cut, and so never mid-character.
 */
#define REASON_MAX 1024

/* The documented PreToolUse deny, on stdout; nothing if it cannot be built. */
static void deny(const char *reason)
{
    cJSON *out = cJSON_CreateObject(), *hso = NULL;
    char *text = NULL;

    if (out != NULL &&
        (hso = cJSON_AddObjectToObject(out, "hookSpecificOutput")) != NULL &&
        cJSON_AddStringToObject(hso, "hookEventName", "PreToolUse") != NULL &&
        cJSON_AddStringToObject(hso, "permissionDecision", "deny") != NULL &&
        cJSON_AddStringToObject(hso, "permissionDecisionReason", reason) != NULL)
        text = cJSON_PrintUnformatted(out);
    if (text != NULL) {
        /* No newline: the form recorded working in k7. */
        fputs(text, stdout);
        cJSON_free(text);
    }
    cJSON_Delete(out);
}

/* Decide on one payload: deny on stdout, or nothing. */
static void hook(const char *root, const cJSON *payload)
{
    const cJSON *input = bash_tool_input(payload);
    char reason[REASON_MAX];
    struct verdict v;

    if (input != NULL &&
        objection(root,
                  cJSON_GetObjectItemCaseSensitive(input, "command")->valuestring,
                  &v, reason, sizeof reason))
        deny(reason);
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
    return out;
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
                           &v, reason, sizeof reason);
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

#ifndef LOADGUARD_TEST

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
 *   decide ROOT    exactly what the hook prints, with /proc and /sys below
 *                  ROOT
 *   report ROOT    any payload: what --report prints, below ROOT
 *   explain ROOT   any payload: what --explain prints, below ROOT
 * Exit 1 if a Bash payload is needed and missing, 64 on usage.
 */
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
