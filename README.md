# jyl-memory

Uploads chosen Claude Code, omp and Codex CLI sessions to JianyueLab memory.
Sessions stay local until you choose them. Nothing uploads in the background.

## Install

    brew install JianyueLab/internal/jyl-memory
    jyl-memory install-skill

Run `jyl-memory install-skill` again after every upgrade.

## Set up

1. At `https://memory.jianyuelab.co/settings/agents`, issue an agent token:
   - agent name: this machine
   - scopes: `conversation:write`, `memory:read`
   - projects: those you want to upload to; none means My memory only
2. `jyl-memory config set-token`, then paste the token and press Ctrl-D.

`JYL_MEMORY_TOKEN` and `JYL_MEMORY_URL` override the config file.

## Use

| Agent | Invoke |
|---|---|
| Claude Code | `/jyl-memory` |
| Codex | `$jyl-memory` |
| omp | `/skill:jyl-memory` (needs `skills.enableSkillCommands`), or ask for jyl-memory |

The skill lists waiting sessions. You answer with numbers to upload or to skip.

CLI:

    jyl-memory list [--json] [--days N] [--include-skipped]
    jyl-memory projects [--json]
    jyl-memory send <key>... --project <id> [--visibility private|project] [--days N] [--json]
    jyl-memory skip <key>...
    jyl-memory status [--json]

## What is uploaded

- Messages: user and assistant text only. Tool calls, tool output, thinking, system and developer messages and subagent threads are dropped.
- Context the tool adds as user text is dropped:
  - Claude Code: `<system-reminder>` blocks, slash-command and `!` shell echoes, local-command caveats, task notifications, compaction summaries.
  - omp: custom messages.
  - Codex: AGENTS.md blocks, whole `<tag>…</tag>` blocks such as `<environment_context>` (answers to the agent's questions are kept), in-app browser context, image markers.
- Each conversation also carries its title, working directory, git remote and branch, tool version, the jyl-memory version and the host name.
- Secrets matching known shapes in message text, titles and git remotes are replaced with `[REDACTED:<type>]`. Unknown formats are not caught.
- A private session is uploaded with consent for the memory service to send it to its extraction model.
- After a session is sent, later messages show up again as new and upload only when chosen.
- To remove an uploaded session, delete the conversation in the memory web UI.

## Files

| Path | Content |
|---|---|
| `~/.config/jyl-memory/config.json` | `base_url`, `token` (mode 0600) |
| `~/.local/state/jyl-memory/state.json` | sent message IDs and skipped sessions per session |

Sessions are read from `~/.claude/projects`, `~/.omp/agent/sessions` and `~/.codex/sessions`, or from `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `CODEX_HOME`.

## Development

    bun test

Runtime is Node.js 22 or later, with no dependencies.

The `homebrew-internal` formula test asserts two outputs:
- `jyl-memory --version` prints the version
- `jyl-memory list --json` in an empty `HOME` prints `[]`

Changing either breaks `brew test`.
The upload request body is the `memory` REST contract `POST /api/v1/conversations`.
