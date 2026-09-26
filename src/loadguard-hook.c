/*
 * loadguard-hook — PreToolUse hook on Bash, the compiled path (k8).
 *
 * Stage 0: pass-through. It reads the payload, parses it and extracts
 * tool_name / tool_input.command, then decides nothing: no stdout, exit 0,
 * which Claude Code treats as "no decision" — the command runs as is.
 *
 * Fail open: whatever goes wrong (empty or oversized stdin, not UTF-8, broken
 * JSON, missing fields, out of memory) ends in exit 0 with nothing on stdout.
 * Never exit 2: that is the only code with which a hook blocks a command.
 *
 * Cheap: no fork, no exec, no file other than stdin. JSON only via the
 * vendored cJSON (vendor/cJSON/) — commands carry escapes, heredocs, Unicode.
 *
 * Built with -DLOADGUARD_TEST, main() is swapped for a test driver that
 * exposes the extraction and the updatedInput builder (t/test_hook_binary.py);
 * the production binary has no test mode.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "cJSON.h"

/* Larger payloads pass through unparsed. */
#define MAX_PAYLOAD ((size_t)8 << 20)

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
 * would be copied verbatim into updatedInput, a NUL would end the text early.
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

/*
 * updatedInput for a rewrite: updatedInput REPLACES tool_input (k7), so it is
 * a deep copy of every key the model set with only command swapped. The
 * caller owns the result; NULL if out of memory.
 * Unused until k3 wraps commands; exercised by the test driver.
 */
__attribute__((unused))
static cJSON *updated_input(const cJSON *tool_input, const char *command)
{
    cJSON *copy = cJSON_Duplicate(tool_input, 1);
    cJSON *cmd = cJSON_CreateString(command);

    if (copy == NULL || cmd == NULL ||
        !cJSON_ReplaceItemInObjectCaseSensitive(copy, "command", cmd)) {
        cJSON_Delete(copy);
        cJSON_Delete(cmd);
        return NULL;
    }
    return copy;
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

int main(void)
{
    size_t len = 0;
    char *buf = read_stdin(&len);
    cJSON *payload;

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
    bash_tool_input(payload);
    /* No decision yet: stay silent. */
    cJSON_Delete(payload);
    return 0;
}

#else /* LOADGUARD_TEST */

/*
 * Test driver, payload on stdin:
 *   command              print tool_input.command verbatim
 *   updated-input CMD    print updatedInput with command CMD as JSON
 * Exit 1 if the payload is not a Bash payload with a command, 64 on usage.
 */
int main(int argc, char **argv)
{
    size_t len = 0;
    char *buf = read_stdin(&len);
    cJSON *payload = buf ? parse_payload(buf, len) : NULL;
    const cJSON *input = bash_tool_input(payload);
    int rc = 1;

    free(buf);
    if (input != NULL && argc == 2 && strcmp(argv[1], "command") == 0) {
        fputs(cJSON_GetObjectItemCaseSensitive(input, "command")->valuestring,
              stdout);
        rc = 0;
    } else if (input != NULL && argc == 3 &&
               strcmp(argv[1], "updated-input") == 0) {
        cJSON *out = updated_input(input, argv[2]);
        char *text = out ? cJSON_PrintUnformatted(out) : NULL;
        if (text != NULL) {
            fputs(text, stdout);
            rc = 0;
        }
        cJSON_free(text);
        cJSON_Delete(out);
    } else if (input != NULL) {
        rc = 64;
    }
    cJSON_Delete(payload);
    return rc;
}

#endif
