# Hook payload fixtures

**All payloads here are reconstructed, not recorded.** They follow the PreToolUse
input schema at https://code.claude.com/docs/en/hooks as read on 2026-09-26. No
Claude Code session was instrumented to capture them; replace them with recorded
payloads once a capture path exists that does not touch the live `~/.claude`.

| File | Case |
|---|---|
| `bash-plain.json` | light Bash command |
| `bash-heredoc.json` | heredoc, mixed quotes, `$HOME`, `cd`, `&&`, subshell |
| `bash-background.json` | `run_in_background: true` |
| `bash-subagent.json` | fired inside a subagent (`agent_id`, `agent_type`) |
| `bash-no-command.json` | Bash payload without `tool_input.command` |
| `read-tool.json` | non-Bash tool |
| `broken.json` | truncated JSON |
| `empty.json` | empty stdin |
| `not-an-object.json` | valid JSON, not an object |
| `invalid-utf8.json` | bytes that are not UTF-8 |
