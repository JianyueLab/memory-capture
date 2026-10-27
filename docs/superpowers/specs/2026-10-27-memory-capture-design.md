# 会话采集设计

日期：2026-10-27。
仓库：`JianyueLab/memory-capture`，公开。
状态：设计已确认，实施计划见 `docs/superpowers/plans/2026-10-27-memory-capture.md`。代码尚未实现。

## 1. 目标与边界

把 Claude Code、omp 与 Codex CLI 的本地会话上传到 `memory` 服务。
会话留在本机，由用户在 agent 内选择后才上传。
选择单位是整个会话。
上传前只保留对话正文，并做规则脱敏。
选择上传即视为同意把该会话发给提取模型。

不做：后台自动上传、按消息裁剪、网页收件箱、从 CLI 删除服务器数据、JianyueLab `harness` 的采集。

## 2. 已作决定

- 独立仓库 `memory-capture`。不放进 `harness-plugin`，不放进 `memory`。
- 运行时为 Node.js 22 或更高，零依赖 ESM。测试用 `bun test`。
- 入口是一个 skill，名为 `jyl-memory`。Claude Code 用 `/jyl-memory` 调用，omp 用 `/skill:jyl-memory`（需开启 `skills.enableSkillCommands`），Codex 用 `$jyl-memory`。不用 `memory`：Claude Code 内建 `/memory`。
- 实际工作由 CLI `jyl-memory` 完成。skill 只调用 CLI，不读取会话文件。
- 仓库公开。Homebrew 7 的下载 sandbox 读不到 git 凭据，私有仓库无法通过 formula 安装。
- 通过 Homebrew tap `JianyueLab/internal` 分发，formula 下载公开仓库的 release tarball。
- 服务端改动：`POST /api/v1/conversations` 增加 `model_consent`。见第 12 节。
- 版本号遵循 `vXX.YY.ZZ`。预发布为 `27.0.x`，首个正式版为 `v27.1.0`。
- 客户端发布晚于服务端改动上线：服务端拒绝未知字段，旧服务端会以 `400` 拒绝 `model_consent`。

## 3. 仓库结构

```text
bin/jyl-memory            CLI 入口
src/cli.mjs               参数解析与命令分发
src/config.mjs            配置与凭据
src/state.mjs             本地状态与文件锁
src/sources/index.mjs     会话发现与 git remote 补全
src/sources/claude-code.mjs
src/sources/omp.mjs
src/sources/codex.mjs
src/sources/files.mjs     会话文件枚举
src/filter.mjs            正文过滤规则的公共部分
src/scrub.mjs             脱敏
src/upload.mjs            REST 上传
skill/SKILL.md            /jyl-memory skill
test/                     bun test 与脱敏后的会话样本
docs/superpowers/specs/   设计
```

## 4. 配置与凭据

- 配置文件：`~/.config/jyl-memory/config.json`，权限 `0600`。字段 `base_url`、`token`。
- 环境变量 `JYL_MEMORY_URL`、`JYL_MEMORY_TOKEN` 优先于配置文件。
- `base_url` 默认 `https://memory.jianyuelab.co`。
- Token 为 `mem_` Agent Token，在网页 `/settings/agents` 签发。
  - `agent_name` 填设备名。一台设备一个 Agent。
  - scope 为 `conversation:write` 与 `memory:read`。
  - `project_ids` 为允许上传的项目。为空时只有个人项目 My memory。
- `jyl-memory config set-token` 从 stdin 读取 Token，不接受命令行参数。
- 输出与日志不含 Token。

## 5. 会话发现

| 工具 | 位置 | `source_platform` | `source_conversation_id` |
|---|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl`，默认 `~/.claude` | `claude-code` | 行内 `sessionId` |
| omp | `$PI_CODING_AGENT_DIR/sessions/*/*.jsonl`，默认 `~/.omp/agent` | `omp` | 会话头 `id` |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`，默认 `~/.codex` | `codex` | `session_meta.payload.id` |

- 默认扫描最近 30 天内修改过的文件。`--days N` 可改。
- 只读完整的行。未写完的末行忽略。
- 正在进行的会话也可选。之后新增的对话会作为新内容再次列出。
- 过滤后没有用户正文的会话不列出。
- 会话键为 `<source_platform>:<source_conversation_id>`。

## 6. 正文过滤

只保留用户与助手的正文。其余全部丢弃。

Claude Code：
- 保留 `type: "user"` 中的字符串正文与 `text` 块。
- 保留 `type: "assistant"` 中的 `text` 块。
- 丢弃 `isSidechain: true`、`isMeta: true`、`isCompactSummary: true`、`tool_result`、`tool_use`、`thinking`，以及 `attachment`、`api-request*`、`system` 等其他行类型。
- 丢弃以下列标签开头的用户正文：`<command-name>`、`<command-message>`、`<command-args>`、`<local-command-stdout>`、`<local-command-stderr>`、`<local-command-caveat>`、`<bash-input>`、`<bash-stdout>`、`<bash-stderr>`、`<task-notification>`。
- 删除正文中的 `<system-reminder>…</system-reminder>` 块。
- 消息 ID 为行内 `uuid`。
- 标题取最后一条 `ai-title`，没有时取首条用户正文。

omp：
- 从最后一条记录沿 `parentId` 回溯到根，只取这条当前分支。
- 保留 `type: "message"` 且 `message.role` 为 `user` 或 `assistant` 的文本内容。
- 丢弃 `developer`、`toolResult`、`bashExecution`、`toolCall` 块、`custom_message`、摘要与其他记录类型。
- 已上传的旧分支消息留在服务器。切换分支后只追加新分支上未上传的消息。
- 消息 ID 为记录 `id`。
- 标题取会话头标题，没有时取首条用户正文。

Codex：
- 只处理 `session_meta.payload.thread_source` 为 `user` 的会话。子 agent 与 guardian 审查会话（`source.subagent` 存在）不列出。
- 保留 `response_item` 中 `message` 角色为 `user` 的 `input_text` 与角色为 `assistant` 的 `output_text`。
- 丢弃 `developer`、`agent_message`、`reasoning`、函数调用及其输出、`event_msg`、`turn_context` 等其他记录。
- 逐个用户文本块处理注入上下文：
  - 丢弃以 `# AGENTS.md instructions` 开头的块。
  - 丢弃整段为 `<tag>…</tag>` 或 `<tag 属性…>…</tag>` 包裹的块，例如 `<environment_context>`、`<user_instructions>`、`<turn_aborted>`。`<send_user_message_question_reply>…</send_user_message_question_reply>` 块原样保留。
  - 丢弃单独的 `<image …>` 与 `</image>` 标记块。
  - 删除块首的 `<in-app-browser-context …>…</in-app-browser-context>` 元素，保留其后的正文；无剩余正文时丢弃该块。
  - 所有块都被丢弃的消息不保留。
- 消息 ID 为 `payload.id`。缺失时为 `sha256(timestamp + role + 正文)` 的前 32 个十六进制字符；正文为过滤注入上下文之前该角色全部文本块的拼接。
- `git_remote` 与 `git_branch` 取自 `session_meta.payload.git`。
- 标题取首条用户正文。

公共规则：
- 处理后为空的消息丢弃。
- 标题截断到 120 字符。
- 未知记录类型丢弃，不报错。

## 7. 脱敏

在上传与列出之前执行。命中的片段替换为 `[REDACTED:<类型>]`。

| 类型 | 规则 |
|---|---|
| `openai_key` | `sk-` 开头的 key，含 `sk-proj-`、`sk-ant-` |
| `jyl_token` | `mem_` 或 `jyl-` 加 43 位 base64url；`mat_` 加至少 32 位 base64url |
| `github_token` | `ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_` |
| `aws_key` | `AKIA` / `ASIA` 加 16 位大写字母数字 |
| `private_key` | `-----BEGIN … PRIVATE KEY-----` 或 `-----BEGIN … PRIVATE KEY BLOCK-----` 到对应 `END` 的整块，含 PGP 私钥 |
| `jwt` | 三段 base64url，首段以 `eyJ` 开头 |
| `bearer` | `Authorization: Bearer` 后的值 |
| `env_secret` | `NAME=value` 或 `NAME: value` 的值，至少 6 字符。`NAME` 为全大写且含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`PASSWD`，或全小写且含 `_key`、`_token`、`_secret`、`password`、`passwd` |
| `url_credential` | URL 中的 `user:password@` |

- 单条消息超过 100000 code points 时截断，末尾加 `[TRUNCATED]`。
- 脱敏规则变化会改变已上传消息的正文。所以只上传尚未上传的消息，不重发已上传的消息。

## 8. 本地状态

- 文件：`$XDG_STATE_HOME/jyl-memory/state.json`，默认 `~/.local/state/jyl-memory/state.json`，权限 `0600`。
- 写入前取同目录的 `lock` 文件锁。锁超过 60 秒视为失效。
- 每个会话键一条记录：

```json
{
  "decision": "sent",
  "project_id": "uuid",
  "visibility": "private",
  "conversation_id": "uuid",
  "revision": 3,
  "sent_message_ids": ["…"],
  "updated_at": "2026-10-27T00:00:00.000Z"
}
```

- `decision` 为 `sent` 或 `skipped`。没有记录即为未处理。
- 待处理会话：没有记录；或 `decision` 为 `sent` 且存在不在 `sent_message_ids` 内的消息。
- `skipped` 的会话不再列出，`list --include-skipped` 除外。
- 每批上传成功后立即写入状态。

## 9. CLI

| 命令 | 作用 |
|---|---|
| `jyl-memory list [--json] [--days N] [--include-skipped]` | 列出待处理会话 |
| `jyl-memory projects [--json]` | 调用 `GET /api/v1/projects`，列出 Token 可写的项目 |
| `jyl-memory send <key>… --project <id> [--visibility private\|project] [--days N] [--json]` | 过滤、脱敏、上传，记为 `sent` |
| `jyl-memory skip <key>…` | 记为 `skipped` |
| `jyl-memory config set-token` | 从 stdin 写入 Token |
| `jyl-memory status [--json]` | 显示是否已配置（`configured`）、配置来源、`base_url`、Token 前缀与状态计数 |
| `jyl-memory install-skill` | 写入 `~/.claude/skills/jyl-memory/SKILL.md` 与 `~/.codex/skills/jyl-memory/SKILL.md` |
| `jyl-memory --version` | 版本号 |

`list --json` 每项：

```json
{
  "key": "claude-code:6f1c…",
  "tool": "claude-code",
  "cwd": "/Users/alice/work/project",
  "git_remote": "git@github.com:example/project.git",
  "started_at": "2026-10-27T01:00:00.000Z",
  "updated_at": "2026-10-27T02:00:00.000Z",
  "title": "memory embedding 排查",
  "pending_messages": 42,
  "previously_sent": false,
  "skipped": false
}
```

- 列表按 `updated_at` 倒序。
- 标题经过脱敏。
- `send` 到个人项目时可见性固定为 `private`，忽略 `--visibility`。团队项目缺省为 `private`。
- 一个会话已发送过时，`--project` 与 `--visibility` 必须与状态中的值相同，否则报参数错误。
- 一个会话的状态中已有 `conversation_id` 而服务器返回不同的 ID 时，该会话的结果带 `replaced_conversation_id`（旧 ID），文本输出也注明。
- 退出码：成功 0；配置或参数错误 2；上传失败 1。

## 10. `/jyl-memory` skill 流程

1. 运行 `jyl-memory status --json`。`configured` 为 `false` 时，提示到 `{base_url}/settings/agents` 签发 Token 并运行 `jyl-memory config set-token`，然后结束。再运行 `jyl-memory list --json`。
2. 用编号文本列出会话：工具、目录名、时间、标题、待上传条数、是否发过。
3. 请用户按编号回复，分为上传与永久跳过。未提到的会话留待下次。
4. 有要上传的会话时，运行 `jyl-memory projects --json`，请用户选择项目。团队项目再选 `private` 或 `project`，默认 `private`。
5. 运行 `jyl-memory send …` 与 `jyl-memory skip …`。`send` 退出码为 2 时没有发送任何会话：显示错误信息；信息为某会话 "was sent to project X as V" 时，提出用 `--project X`（V 为 `project` 时加 `--visibility project`）单独重发该会话。
6. 报告每个会话的结果与网页地址 `{base_url}/conversations/{id}`。

- 用编号文本而不用选择控件：会话可能多于选择控件的选项上限。
- skill 不读取会话文件，不上传正文，不调用 MCP 写入工具。

## 11. 上传

- 端点：`POST {base_url}/api/v1/conversations`，`Authorization: Bearer mem_…`。
- 请求字段：
  - `project_id`、`source_platform`、`source_conversation_id`、`title`
  - `visibility`：个人项目为 `private`；团队项目为用户选择的值
  - `occurred_at`：会话首条消息时间
  - `agent_label`：工具名
  - `device`：主机名
  - `metadata`：`cwd`、`git_remote`、`git_branch`、`tool_version`、`capture_version`
  - `participants`：用户（`human`）与工具名（`agent`）
  - `messages`：`source_message_id`、`role`、`content`、`occurred_at`
  - `model_consent: true`：仅 `private` 会话
- 只发送不在 `sent_message_ids` 内的消息，按原顺序。
- 分批：每批至多 1000 条且序列化后至多 8 MiB。
- 不发送 `expected_revision`。追加按 `source_message_id` 幂等，重发已存储的相同消息为 no-op；同一设备上的并发由本地锁排除。
- 错误处理：

| 响应 | 处理 |
|---|---|
| `2xx` | 记录本批消息与 `revision`，继续 |
| `401`、`403` | 停止全部上传，提示检查 Token 与 scope |
| `404` | 停止该会话，提示项目不在 Token 范围内 |
| `409 message_conflict`、`409 conversation_conflict` | 停止该会话，提示本地与服务器不一致 |
| `413` | 停止该会话 |
| 网络错误、`429`、`5xx` | 退避重试 3 次，仍失败则停止该会话 |

- 没有离线队列。失败的会话保持待处理，下次再选。
- 请求超时 30 秒。

## 12. memory 服务端改动

`POST /api/v1/conversations` 的 ConversationInput 增加可选字段 `model_consent`。

- 只接受 `true`。`false` 返回 `400 invalid_request`。撤回仍只能在网页进行。
- 会话为 `project` 可见性时返回 `409 invalid_state`。
- 会话为 `private` 时，调用者即创建者。他人的 `private` 会话本就返回 `404`。
- 在同一事务内记录同意，写入审计 `conversation.model_consent.grant`，然后再创建处理任务，使提取任务直接为 `queued`。
- 已有同意时保留首次同意时间，不写审计。
- MCP `jyl_conversation_add` 的参数与 REST 请求体相同，因此同样接受该字段。
- 更新 `contract/rest.md`、`contract/openapi.yaml`、`contract/mcp.md`、README 外发策略一节，以及 `PUT /conversations/{id}/model-consent` 一节中「Agent Token 与 MCP 不能修改」的表述。
- 测试：新建与追加时授予同意；`false` 被拒；`project` 会话被拒；重复同意不改时间、不写审计；提取任务状态为 `queued`。

## 13. 前置条件

- 提取需要部署端开启：设置 `EXTRACTION_*` 与 `EXTRACTION_ENABLED=true`。否则会话可存储、可按关键词检索，但不生成记忆。
- 语义检索需要可用的 embeddings 后端。不影响本设计的其他部分。

## 14. 分发

- `homebrew-internal` 增加 formula `jyl-memory`：
  - `url` 为公开仓库 tag 的 tarball，带 `sha256`
  - `depends_on "node"`
  - `libexec` 安装 `package.json`、`bin/`、`src/`、`skill/`；`bin/jyl-memory` 为调用 Homebrew node 的包装脚本
- `test do` 只断言 `jyl-memory --version` 的输出，以及空 `HOME` 下 `jyl-memory list --json` 输出 `[]`。
- 改动这两条输出会让 tap 的 `brew test` 失败。README 写明这一耦合。
- 安装：`brew install JianyueLab/internal/jyl-memory`，然后 `jyl-memory install-skill`。升级后重新运行 `install-skill`。
- omp 读取 `~/.claude/skills`，因此不需要单独安装。

## 15. 工作区

- 新仓库加入工作区根仓库作为 submodule。
- 根 `CLAUDE.md` 的仓库表增加一行，并注明它与 `memory` 的 REST 契约耦合：上传请求体变化会让已安装的客户端失败。

## 16. 测试

- `bun test`。不访问网络，不读取真实主目录。
- 每个读取器各有一份由真实会话裁剪并替换正文的样本，断言保留与丢弃的结果、消息 ID、标题和分支选择。
- 脱敏：每个类型至少一条命中样本与一条不应命中的样本。
- 状态：待处理判定、`skipped`、锁、每批写入。
- 上传：用替身 `fetch` 覆盖分批、`expected_revision`、第 11 节表中的各响应。
- 冒烟：对已部署的 `memory` 上传一个真实会话，在网页确认消息与同意状态，然后删除该会话。
