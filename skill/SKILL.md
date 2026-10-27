---
name: jyl-memory
description: Use when the user runs /jyl-memory, $jyl-memory or /skill:jyl-memory, or asks to save, upload or skip recent Claude Code, omp or Codex sessions for JianyueLab memory. Lists local sessions, lets the user choose which to upload or skip, and uploads only the chosen ones with the jyl-memory CLI.
---

# jyl-memory

Upload the sessions the user chooses to the JianyueLab memory service.
The `jyl-memory` CLI reads, filters, scrubs and uploads. Never read transcript files yourself, never put transcript text into a tool call, and never use memory MCP write tools for this.

Reply in the user's language.

## Steps

1. Run `jyl-memory status --json`.
   - Command not found: tell the user to run `brew install JianyueLab/internal/jyl-memory` and `jyl-memory install-skill`, then stop.
   - `configured` is `false`: tell the user to issue an agent token at `<base_url>/settings/agents` with scopes `conversation:write` and `memory:read`, listing the projects they want to upload to, then run `jyl-memory config set-token` and paste the token on stdin. Stop.
2. Run `jyl-memory list --json`. If the array is empty, say that nothing is waiting and stop.
3. Show the sessions as a numbered list in array order, one line each: `tool`, the last path segment of `cwd`, `updated_at` in local time, `title`, `pending_messages` new messages, and "sent before" when `previously_sent` is true.
4. Ask which numbers to upload and which to skip permanently. Sessions not mentioned stay for next time. Use plain text, not a choice widget: the list can be longer than a widget allows.
5. If at least one session is to be uploaded:
   1. Say once in this conversation: uploading a private session also allows the memory service to send it to its extraction model.
   2. Run `jyl-memory projects --json` and show the projects as a numbered list. Ask which project to use.
   3. If the chosen project's `kind` is `team`, ask `private` (default) or `project` visibility.
   4. Run `jyl-memory send <key> <key>… --project <id> --json`, adding `--visibility project` only when chosen. Use the `key` values from step 2, never the numbers.
6. If sessions were chosen to skip, run `jyl-memory skip <key> <key>…`.
7. Report each `send` result: `sent` with `url` and `uploaded`, and the old conversation ID when `replaced_conversation_id` is present; `nothing_new`; `failed` with `error`; `not_attempted`. Exit status 1 means at least one session failed; failed sessions stay in the list.
   Exit status 2 means nothing was sent. Show the error message. When it says a session "was sent to project X as V", offer to send that session again on its own with `--project X`, adding `--visibility project` when V is `project`, separately from the other sessions.
