# jyl-memory 会话采集 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地 CLI `jyl-memory` 与 skill `jyl-memory`：列出 Claude Code、omp、Codex 的本地会话，用户选中后过滤、脱敏、上传到 `memory` 服务。

**Architecture:** 零依赖 Node ESM。三个读取器把各自的会话文件转成统一的 `Session`；`discover` 汇总；`state.json` 记录已发送的消息 ID 与跳过的会话；`upload` 按批调用 `POST /api/v1/conversations`。skill 只调用 CLI。

**Tech Stack:** Node.js ≥ 22（运行时），Bun（`bun test`），Homebrew formula（分发）。

**Spec:** `docs/superpowers/specs/2026-10-27-memory-capture-design.md`

## Global Constraints

- 运行时 Node.js 22 或更高；`package.json` 无 `dependencies`、无 `devDependencies`。
- 源码为 `.mjs`，测试为 `test/*.test.js`（`"type": "module"`），用 `bun test` 运行。
- 测试不访问网络，不读取真实主目录；临时目录只在仓库内 `.temp/`，测试结束删除。
- 测试中的密钥样例在运行时拼接（如 `'gh' + 'p_' + 'a'.repeat(36)`），不在源码里出现完整的密钥形状字符串。
- `base_url` 默认 `https://memory.jianyuelab.co`；Token 格式 `^mem_[A-Za-z0-9_-]{43}$`。
- 每批至多 1000 条消息、序列化后至多 8 MiB；不发送 `expected_revision`。
- 单条消息至多 100000 code points，超出截断并以 `\n[TRUNCATED]` 结尾；标题至多 120 code points。
- 请求超时 30 秒；网络错误、`429`、`5xx` 退避重试 3 次（1 s、2 s、4 s）。
- 退出码：成功 0；配置或参数错误 2；上传失败 1。
- `jyl-memory --version` 输出 `package.json` 的版本号加换行；空 `HOME` 下 `jyl-memory list --json` 输出 `[]` 加换行。这两条是 Homebrew `test do` 的契约。
- 版本号 `vXX.YY.ZZ`：预发布 `27.0.x`，首个正式版 `v27.1.0`。
- 客户端正式发布（Task 15）晚于 `memory` 的 `model_consent` 改动上线（`memory/docs/superpowers/plans/2026-10-27-upload-model-consent.md`）。
- 文档与提交信息：陈述事实，不解释理由。

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 版本号、`bin`、测试脚本 |
| `bin/jyl-memory` | Node 入口，调用 `run` |
| `src/version.mjs` | 读取 `package.json` 版本号 |
| `src/scrub.mjs` | 脱敏规则 |
| `src/filter.mjs` | JSONL 解析、正文收尾、标题 |
| `src/sources/files.mjs` | 会话文件枚举 |
| `src/sources/claude-code.mjs` | Claude Code 读取器 |
| `src/sources/omp.mjs` | omp 读取器 |
| `src/sources/codex.mjs` | Codex 读取器 |
| `src/sources/index.mjs` | `discover`、会话键、git remote 补全 |
| `src/state.mjs` | 本地状态、文件锁、待上传判定 |
| `src/config.mjs` | 配置与 Token |
| `src/upload.mjs` | 请求体、分批、REST 调用 |
| `src/cli.mjs` | 命令 |
| `skill/SKILL.md` | `/jyl-memory` skill |
| `test/helpers.js`、`test/fixtures.js` | 测试工具与合成会话样本 |

统一的会话类型（所有读取器的返回值）：

```js
/**
 * @typedef {{ id: string, role: 'user'|'assistant', content: string, occurredAt: string|null }} Message
 * @typedef {{
 *   platform: 'claude-code'|'omp'|'codex', id: string, cwd: string|null,
 *   gitRemote: string|null, gitBranch: string|null, toolVersion: string|null,
 *   title: string|null, startedAt: string|null, updatedAt?: string, messages: Message[]
 * }} Session
 */
```

---

### Task 1: 仓库骨架与 `--version`

**Files:**
- Create: `package.json`、`.gitignore`、`bin/jyl-memory`、`src/version.mjs`、`src/cli.mjs`、`test/helpers.js`、`test/cli.test.js`

**Interfaces:**
- Produces: `run(argv: string[], overrides?: object): Promise<number>`（`src/cli.mjs`）；`VERSION: string`（`src/version.mjs`）；测试工具 `tempDir(name)`、`cleanup(dir)`、`writeJsonl(path, lines, mtime?)`、`jsonl(lines)`、`sink()`。

- [ ] **Step 1: 写骨架文件**

`package.json`：

```json
{
  "name": "jyl-memory",
  "version": "27.0.0",
  "private": true,
  "type": "module",
  "description": "Upload chosen Claude Code, omp and Codex sessions to JianyueLab memory",
  "bin": { "jyl-memory": "bin/jyl-memory" },
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "bun test",
    "check": "node --check bin/jyl-memory && node --check src/cli.mjs"
  }
}
```

`.gitignore`：

```text
.temp/
node_modules/
```

`bin/jyl-memory`（随后 `chmod +x bin/jyl-memory`）：

```js
#!/usr/bin/env node
import { run } from '../src/cli.mjs';

process.exitCode = await run(process.argv.slice(2));
```

`src/version.mjs`：

```js
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
```

`test/helpers.js`：

```js
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../.temp/', import.meta.url));

/** A fresh directory under <repo>/.temp; remove it with cleanup(). */
export function tempDir(name) {
  const dir = join(ROOT, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** JSONL text: one JSON value per line, trailing newline. */
export function jsonl(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
}

/** Writes JSONL to `path`, creating directories; `mtime` (Date) sets atime and mtime. */
export function writeJsonl(path, lines, mtime) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonl(lines));
  if (mtime) utimesSync(path, mtime, mtime);
}

/** A writable that records everything written. */
export function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}
```

- [ ] **Step 2: 写失败的测试**

`test/cli.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { run } from '../src/cli.mjs';
import { sink } from './helpers.js';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function io() {
  const stdout = sink();
  const stderr = sink();
  return { stdout, stderr };
}

describe('cli basics', () => {
  test('--version prints the package version and a newline (Homebrew test contract)', async () => {
    const { stdout, stderr } = io();
    expect(await run(['--version'], { stdout, stderr })).toBe(0);
    expect(stdout.text()).toBe(`${PACKAGE_VERSION}\n`);
  });

  test('an unknown command prints usage and exits 2', async () => {
    const { stdout, stderr } = io();
    expect(await run(['frobnicate'], { stdout, stderr })).toBe(2);
    expect(stderr.text()).toContain('usage: jyl-memory');
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `bun test test/cli.test.js`
Expected: FAIL，`Cannot find module '../src/cli.mjs'`。

- [ ] **Step 4: 写最小实现**

`src/cli.mjs`（Task 10 会整体替换为完整版本）：

```js
import { VERSION } from './version.mjs';

const USAGE = 'usage: jyl-memory --version';

export async function run(argv, overrides = {}) {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  if (argv[0] === '--version') {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  stderr.write(`${USAGE}\n`);
  return 2;
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `bun test test/cli.test.js && node bin/jyl-memory --version`
Expected: 2 pass；最后一行输出 `27.0.0`。

- [ ] **Step 6: 提交**

```bash
git add package.json .gitignore bin/jyl-memory src/version.mjs src/cli.mjs test/helpers.js test/cli.test.js
git commit -m "Add jyl-memory package skeleton and --version"
```

---

### Task 2: 脱敏与正文处理

**Files:**
- Create: `src/scrub.mjs`、`src/filter.mjs`、`test/scrub.test.js`、`test/filter.test.js`

**Interfaces:**
- Produces:
  - `scrub(text: string): string`
  - `parseJsonLines(text: string): object[]`
  - `finalizeContent(text: string): string`（`''` 表示丢弃该消息）
  - `makeTitle(text: string|null|undefined): string|null`
  - `truncateCodePoints(text: string, max: number): string`
  - 常量 `MAX_CODE_POINTS = 100000`、`TITLE_CODE_POINTS = 120`

- [ ] **Step 1: 写失败的测试**

`test/scrub.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { scrub } from '../src/scrub.mjs';

const b64 = (n) => 'Ab1_-'.repeat(Math.ceil(n / 5)).slice(0, n);

describe('scrub redacts', () => {
  const cases = [
    ['openai_key', `key is ${'sk-'}proj-${b64(40)} ok`],
    ['openai_key', `${'sk-'}ant-api03-${b64(40)}`],
    ['jyl_token', `token ${'mem'}_${b64(43)}`],
    ['jyl_token', `${'jyl'}-${b64(43)}`],
    ['jyl_token', `${'mat'}_${b64(40)}`],
    ['github_token', `${'gh'}p_${'a1'.repeat(18)}`],
    ['github_token', `${'github'}_pat_${'a1_'.repeat(12)}`],
    ['aws_key', `${'AKIA'}${'ABCDEFGH12345678'}`],
    ['jwt', `${'eyJ'}hbGciOiJIUzI1.${'eyJ'}zdWIiOiIx.c2lnbmF0dXJl`],
    ['bearer', 'Authorization: Bearer abcdef123456789'],
    ['env_secret', 'export OPENAI_API_KEY=abc123def456'],
    ['env_secret', '"client_secret": "s3cr3t-value"'],
    ['env_secret', 'password: hunter22'],
    ['url_credential', 'postgres://app:pa55word@db.internal:5432/app'],
  ];
  for (const [type, input] of cases) {
    test(`${type}: ${input.slice(0, 24)}`, () => {
      const out = scrub(input);
      expect(out).toContain(`[REDACTED:${type}]`);
    });
  }

  test('a private key block is replaced as a whole', () => {
    const block = `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nAAAA\nBBBB\n-----END ${'OPENSSH'} PRIVATE KEY-----`;
    expect(scrub(`before\n${block}\nafter`)).toBe('before\n[REDACTED:private_key]\nafter');
  });

  test('the URL keeps its scheme and host', () => {
    expect(scrub('https://bob:hunter2@example.com/x')).toBe('https://[REDACTED:url_credential]@example.com/x');
  });

  test('an already redacted value is not re-labelled by env_secret', () => {
    expect(scrub(`API_KEY=${'sk-'}${b64(30)}`)).toBe('API_KEY=[REDACTED:openai_key]');
  });
});

describe('scrub leaves ordinary text alone', () => {
  const keep = [
    'the jyl-usage plugin and jyl-memory CLI',
    'primary key: user_id',
    'risk-assessment-framework-document-v2',
    'AKIA is a prefix',
    'Bearer token',
    'monkey: bananas',
    'see https://example.com/path@v2',
  ];
  for (const text of keep) {
    test(text, () => expect(scrub(text)).toBe(text));
  }
});
```

`test/filter.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { finalizeContent, makeTitle, parseJsonLines, truncateCodePoints } from '../src/filter.mjs';

describe('parseJsonLines', () => {
  test('skips blank, malformed, non-object lines and an unterminated last line', () => {
    const text = '{"a":1}\n\nnot json\n[1,2]\n"str"\n{"b":2}\n{"c":';
    expect(parseJsonLines(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('finalizeContent', () => {
  test('removes system-reminder blocks and trims', () => {
    expect(finalizeContent('  hi <system-reminder>x\ny</system-reminder> there ')).toBe('hi  there');
  });

  test('returns empty when only a reminder remains', () => {
    expect(finalizeContent('<system-reminder>only</system-reminder>')).toBe('');
  });

  test('drops NUL and repairs lone surrogates', () => {
    expect(finalizeContent('a\u0000b\uD800c')).toBe('ab\uFFFDc');
  });

  test('scrubs before truncating', () => {
    expect(finalizeContent('password: hunter22')).toBe('password: [REDACTED:env_secret]');
  });

  test('caps at 100000 code points ending in the marker', () => {
    const out = finalizeContent('😀'.repeat(100_001));
    expect(Array.from(out).length).toBe(100_000);
    expect(out.endsWith('\n[TRUNCATED]')).toBe(true);
  });
});

describe('truncateCodePoints', () => {
  test('leaves text at the limit unchanged', () => {
    expect(truncateCodePoints('abc', 3)).toBe('abc');
  });
});

describe('makeTitle', () => {
  test('collapses whitespace to one line', () => {
    expect(makeTitle('  Fix\n\nthe   build ')).toBe('Fix the build');
  });

  test('caps at 120 code points with an ellipsis', () => {
    const title = makeTitle('字'.repeat(200));
    expect(Array.from(title).length).toBe(120);
    expect(title.endsWith('…')).toBe(true);
  });

  test('null for empty or non-string input', () => {
    expect(makeTitle('   ')).toBeNull();
    expect(makeTitle(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/scrub.test.js test/filter.test.js`
Expected: FAIL，找不到 `../src/scrub.mjs` 与 `../src/filter.mjs`。

- [ ] **Step 3: 写实现**

`src/scrub.mjs`：

```js
// Rules run in order. A rule with `pre`/`secret`/`post` groups keeps `pre` and `post` and replaces only
// `secret`; other rules replace the whole match. Lookbehind is avoided so Node (V8) and Bun (JSC) agree.
const RULES = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['url_credential', /(?<pre>\b[a-z][a-z0-9+.-]*:\/\/)(?<secret>[^\s:@/]+:[^\s@/]+)(?<post>@)/gi],
  ['bearer', /(?<pre>\bBearer\s+)(?<secret>(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,})/g],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['jyl_token', /\b(?:mem_|jyl-)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|\bmat_[A-Za-z0-9_-]{32,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  [
    'env_secret',
    /(?<pre>\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*|[a-z0-9_]*(?:_key|_token|_secret|password|passwd)[a-z0-9_]*)["']?\s*[:=]\s*["']?)(?<secret>(?!\[REDACTED)[^\s"'`,;]{6,})/g,
  ],
];

/** Replaces known secret shapes with `[REDACTED:<type>]`. */
export function scrub(text) {
  let out = text;
  for (const [type, pattern] of RULES) {
    const marker = `[REDACTED:${type}]`;
    out = out.replace(pattern, (...args) => {
      const groups = args.at(-1);
      if (groups && typeof groups === 'object' && groups.secret !== undefined) {
        return `${groups.pre ?? ''}${marker}${groups.post ?? ''}`;
      }
      return marker;
    });
  }
  return out;
}
```

`src/filter.mjs`：

```js
import { scrub } from './scrub.mjs';

export const MAX_CODE_POINTS = 100_000;
export const TITLE_CODE_POINTS = 120;
const TRUNCATED = '\n[TRUNCATED]';
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Objects from JSONL text. Blank, malformed and non-object lines and an unterminated last line are skipped. */
export function parseJsonLines(text) {
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop();
  const out = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
    } catch {
      // Malformed line: skipped.
    }
  }
  return out;
}

/** `text` cut to `max` code points, the last ones replaced by the truncation marker. */
export function truncateCodePoints(text, max) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max - Array.from(TRUNCATED).length).join('') + TRUNCATED;
}

/** A message body as uploaded. An empty string means the message is dropped. */
export function finalizeContent(text) {
  const cleaned = text.replace(SYSTEM_REMINDER, '').replaceAll('\u0000', '').toWellFormed().trim();
  if (cleaned === '') return '';
  return truncateCodePoints(scrub(cleaned), MAX_CODE_POINTS);
}

/** A one-line, scrubbed title of at most TITLE_CODE_POINTS; null when empty. */
export function makeTitle(text) {
  if (typeof text !== 'string') return null;
  const line = scrub(text.replaceAll('\u0000', '').toWellFormed()).replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  const points = Array.from(line);
  return points.length <= TITLE_CODE_POINTS ? line : points.slice(0, TITLE_CODE_POINTS - 1).join('') + '…';
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/scrub.test.js test/filter.test.js`
Expected: PASS。若某条「保留」用例失败，收紧对应规则而不是删用例。

- [ ] **Step 5: 提交**

```bash
git add src/scrub.mjs src/filter.mjs test/scrub.test.js test/filter.test.js
git commit -m "Add secret scrubbing and message text helpers"
```

---

### Task 3: 合成样本与 Claude Code 读取器

**Files:**
- Create: `test/fixtures.js`、`src/sources/files.mjs`、`src/sources/claude-code.mjs`、`test/claude-code.test.js`

**Interfaces:**
- Consumes: `parseJsonLines`、`finalizeContent`、`makeTitle`（Task 2）
- Produces:
  - `jsonlInSubdirs(root: string): string[]`、`filesAtDepth(root: string, depth: number, accept: (name: string) => boolean): string[]`（`files.mjs`）
  - 读取器模块形状（三个读取器一致）：`platform`、`agentName`、`files({ home, env }): string[]`、`parse(text: string, file: string): Session|null`
  - 样本：`claudeSession(sessionId?, cwd?)`、`ompSession(id?, cwd?)`、`codexSession(id?, cwd?, threadSource?)`，各返回 JSONL 行对象数组

- [ ] **Step 1: 写样本**

`test/fixtures.js`（行形状取自 2026-10 的真实文件：Claude Code、omp v3、codex-cli 0.163.0）：

```js
const at = (prefix, s) => `${prefix}:${String(s).padStart(2, '0')}.000Z`;

export function claudeSession(sessionId = 'c-1', cwd = '/work/alpha') {
  const t = (s) => at('2026-10-27T01:00', s);
  const base = { sessionId, cwd, gitBranch: 'main', version: '2.1.0', isSidechain: false, userType: 'external' };
  return [
    { type: 'user', ...base, uuid: 'u1', parentUuid: null, timestamp: t(0), message: { role: 'user', content: 'How do we deploy?\n<system-reminder>internal</system-reminder>' } },
    { type: 'assistant', ...base, uuid: 'a1', parentUuid: 'u1', timestamp: t(5), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] } },
    { type: 'assistant', ...base, uuid: 'a2', parentUuid: 'a1', timestamp: t(6), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', ...base, uuid: 'u2', parentUuid: 'a2', timestamp: t(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file-list' }] } },
    { type: 'assistant', ...base, uuid: 'a3', parentUuid: 'u2', timestamp: t(8), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'We deploy with kubectl.' }] } },
    { type: 'user', ...base, uuid: 'u3', parentUuid: 'a3', isMeta: true, timestamp: t(9), message: { role: 'user', content: 'Caveat: generated' } },
    { type: 'user', ...base, uuid: 'u4', parentUuid: 'a3', timestamp: t(10), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', ...base, uuid: 'u5', isSidechain: true, timestamp: t(11), message: { role: 'user', content: 'subagent prompt' } },
    { type: 'attachment', sessionId, uuid: 'x1', timestamp: t(12) },
    { type: 'ai-title', aiTitle: 'Deploy question', sessionId },
  ];
}

export function ompSession(id = 'o-1', cwd = '/work/beta') {
  const t = (s) => at('2026-10-27T02:00', s);
  const text = (value) => [{ type: 'text', text: value }];
  return [
    { type: 'title', v: 1, title: '📡 Beta work', source: 'auto', pad: '    ' },
    { type: 'session', id, version: 3, cwd, timestamp: t(0) },
    { type: 'model_change', id: 'e0', parentId: null, timestamp: t(0), model: 'm' },
    { type: 'message', id: 'e1', parentId: 'e0', timestamp: t(1), message: { role: 'user', content: text('Old branch question') } },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: t(2), message: { role: 'assistant', content: text('Old branch answer') } },
    { type: 'message', id: 'e3', parentId: 'e0', timestamp: t(3), message: { role: 'user', content: text('New branch question') } },
    { type: 'message', id: 'e4', parentId: 'e3', timestamp: t(4), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }, { type: 'text', text: 'New branch answer' }] } },
    { type: 'message', id: 'e5', parentId: 'e4', timestamp: t(5), message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: text('tool output') } },
    { type: 'message', id: 'e6', parentId: 'e5', timestamp: t(6), message: { role: 'developer', content: text('developer note') } },
    { type: 'custom_message', id: 'e7', parentId: 'e6', timestamp: t(7), customType: 'x', content: 'injected' },
  ];
}

export function codexSession(id = 'x-1', cwd = '/work/gamma', threadSource = 'user') {
  const t = (s) => at('2026-10-27T03:00', s);
  const item = (s, payload) => ({ timestamp: t(s), type: 'response_item', payload });
  return [
    {
      timestamp: t(0),
      type: 'session_meta',
      payload: {
        id, timestamp: t(0), cwd, cli_version: '0.163.0', originator: 'codex-tui', thread_source: threadSource,
        source: threadSource === 'user' ? 'vscode' : { subagent: { other: 'guardian' } },
        git: { branch: 'main', repository_url: 'git@github.com:JianyueLab/gamma.git' },
      },
    },
    item(1, { type: 'message', role: 'developer', id: 'msg_d', content: [{ type: 'input_text', text: '<permissions instructions>\n</permissions instructions>' }] }),
    item(2, { type: 'message', role: 'user', id: 'msg_u0', content: [
      { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>' },
      { type: 'input_text', text: '<environment_context>\n  <cwd>/work/gamma</cwd>\n</environment_context>' },
    ] }),
    item(3, { type: 'message', role: 'user', id: 'msg_u1', content: [{ type: 'input_text', text: 'Review the open PRs' }] }),
    item(4, { type: 'reasoning', id: 'r1', summary: [] }),
    item(5, { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
    item(6, { type: 'agent_message', id: 'am1', author: '/root/sub', recipient: '/root', content: [{ type: 'input_text', text: 'sub report' }] }),
    item(7, { type: 'message', role: 'assistant', id: 'msg_a1', content: [{ type: 'output_text', text: 'Found six open PRs.' }] }),
    { timestamp: t(8), type: 'event_msg', payload: { type: 'task_complete' } },
  ];
}
```

- [ ] **Step 2: 写失败的测试**

`test/claude-code.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as claudeCode from '../src/sources/claude-code.mjs';
import { claudeSession } from './fixtures.js';
import { cleanup, jsonl, tempDir, writeJsonl } from './helpers.js';

describe('claude-code parse', () => {
  const session = claudeCode.parse(jsonl(claudeSession()), '/x/c-1.jsonl');

  test('keeps only user and assistant text, in file order', () => {
    expect(session.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['u1', 'user', 'How do we deploy?'],
      ['a3', 'assistant', 'We deploy with kubectl.'],
    ]);
  });

  test('takes session fields from the lines', () => {
    expect(session).toMatchObject({
      platform: 'claude-code', id: 'c-1', cwd: '/work/alpha', gitBranch: 'main', toolVersion: '2.1.0',
      title: 'Deploy question', startedAt: '2026-10-27T01:00:00.000Z', gitRemote: null,
    });
  });

  test('falls back to the first user message for the title', () => {
    const lines = claudeSession().filter((l) => l.type !== 'ai-title');
    expect(claudeCode.parse(jsonl(lines), '/x/c-1.jsonl').title).toBe('How do we deploy?');
  });
});

describe('claude-code files', () => {
  test('lists <projects>/<dir>/*.jsonl, honouring CLAUDE_CONFIG_DIR, and skips nested subagent files', () => {
    const home = tempDir('claude-files');
    try {
      const root = join(home, 'alt-claude');
      writeJsonl(join(root, 'projects', '-work-alpha', 'c-1.jsonl'), claudeSession());
      writeJsonl(join(root, 'projects', '-work-alpha', 'c-1', 'subagents', 'agent-1.jsonl'), claudeSession('s'));
      expect(claudeCode.files({ home, env: { CLAUDE_CONFIG_DIR: root } })).toEqual([
        join(root, 'projects', '-work-alpha', 'c-1.jsonl'),
      ]);
    } finally {
      cleanup(home);
    }
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `bun test test/claude-code.test.js`
Expected: FAIL，找不到 `../src/sources/claude-code.mjs`。

- [ ] **Step 4: 写实现**

`src/sources/files.mjs`：

```js
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** `<root>/<dir>/*.jsonl`, exactly one directory level below root. */
export function jsonlInSubdirs(root) {
  const out = [];
  for (const dir of entries(root)) {
    if (!dir.isDirectory()) continue;
    for (const file of entries(join(root, dir.name))) {
      if (file.isFile() && file.name.endsWith('.jsonl')) out.push(join(root, dir.name, file.name));
    }
  }
  return out;
}

/** Files accepted by `accept(name)` exactly `depth` directory levels below root. */
export function filesAtDepth(root, depth, accept) {
  if (depth === 0) {
    return entries(root).filter((e) => e.isFile() && accept(e.name)).map((e) => join(root, e.name));
  }
  return entries(root)
    .filter((e) => e.isDirectory())
    .flatMap((e) => filesAtDepth(join(root, e.name), depth - 1, accept));
}
```

`src/sources/claude-code.mjs`：

```js
import { basename, join } from 'node:path';
import { finalizeContent, makeTitle, parseJsonLines } from '../filter.mjs';
import { jsonlInSubdirs } from './files.mjs';

export const platform = 'claude-code';
export const agentName = 'Claude Code';

const COMMAND_TEXT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;

/** Top-level session files. Subagent transcripts under `<session>/subagents/` are not sessions. */
export function files({ home, env }) {
  return jsonlInSubdirs(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'));
}

function textOf(type, content) {
  if (typeof content === 'string') return type === 'user' ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export function parse(text, file) {
  let id = null;
  let cwd = null;
  let gitBranch = null;
  let toolVersion = null;
  let aiTitle = null;
  const messages = [];
  for (const line of parseJsonLines(text)) {
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string') {
      aiTitle = line.aiTitle;
      continue;
    }
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (line.isSidechain === true || line.isMeta === true) continue;
    if (typeof line.sessionId === 'string') id ??= line.sessionId;
    if (typeof line.cwd === 'string') cwd ??= line.cwd;
    if (typeof line.gitBranch === 'string' && line.gitBranch !== '') gitBranch = line.gitBranch;
    if (typeof line.version === 'string') toolVersion = line.version;
    if (typeof line.uuid !== 'string') continue;
    const raw = textOf(line.type, line.message?.content);
    if (raw === null) continue;
    if (line.type === 'user' && COMMAND_TEXT.test(raw)) continue;
    const content = finalizeContent(raw);
    if (content === '') continue;
    messages.push({ id: line.uuid, role: line.type, content, occurredAt: typeof line.timestamp === 'string' ? line.timestamp : null });
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    platform,
    id: id ?? basename(file, '.jsonl'),
    cwd,
    gitRemote: null,
    gitBranch,
    toolVersion,
    title: makeTitle(aiTitle) ?? makeTitle(firstUser?.content),
    startedAt: messages[0]?.occurredAt ?? null,
    messages,
  };
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `bun test test/claude-code.test.js`
Expected: PASS。

- [ ] **Step 6: 用真实文件核对**

Run:

```bash
node --input-type=module -e "
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as c from './src/sources/claude-code.mjs';
const files = c.files({ home: homedir(), env: process.env }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 3);
for (const f of files) { const s = c.parse(readFileSync(f, 'utf8'), f); console.log(s.id, s.messages.length, s.messages.map(m => m.role).join(','), '|', s.title); }
"
```

Expected: 每行一个会话，角色序列只有 `user` 与 `assistant`，标题非空。只看统计，不打印正文。

- [ ] **Step 7: 提交**

```bash
git add test/fixtures.js src/sources/files.mjs src/sources/claude-code.mjs test/claude-code.test.js
git commit -m "Add Claude Code session reader"
```

---

### Task 4: omp 读取器

**Files:**
- Create: `src/sources/omp.mjs`、`test/omp.test.js`

**Interfaces:**
- Consumes: `parseJsonLines`、`finalizeContent`、`makeTitle`（Task 2）；`jsonlInSubdirs`（Task 3）
- Produces: 读取器模块 `platform = 'omp'`、`agentName = 'omp'`、`files({ home, env })`、`parse(text, file)`

- [ ] **Step 1: 写失败的测试**

`test/omp.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as omp from '../src/sources/omp.mjs';
import { ompSession } from './fixtures.js';
import { cleanup, jsonl, tempDir, writeJsonl } from './helpers.js';

describe('omp parse', () => {
  const session = omp.parse(jsonl(ompSession()), '/x/2026_o-1.jsonl');

  test('follows the active branch from the last entry and keeps user/assistant text only', () => {
    expect(session.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['e3', 'user', 'New branch question'],
      ['e4', 'assistant', 'New branch answer'],
    ]);
  });

  test('takes id, cwd and the title slot', () => {
    expect(session).toMatchObject({ platform: 'omp', id: 'o-1', cwd: '/work/beta', title: '📡 Beta work', startedAt: '2026-10-27T02:00:03.000Z' });
  });

  test('stops on a parent cycle instead of looping', () => {
    const lines = [
      { type: 'session', id: 'o-2', version: 3, cwd: '/w', timestamp: '2026-10-27T02:00:00.000Z' },
      { type: 'message', id: 'a', parentId: 'b', timestamp: '2026-10-27T02:00:01.000Z', message: { role: 'user', content: 'A' } },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-10-27T02:00:02.000Z', message: { role: 'assistant', content: 'B' } },
    ];
    expect(omp.parse(jsonl(lines), '/x/o-2.jsonl').messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('falls back to the first user message for the title', () => {
    const lines = ompSession().filter((l) => l.type !== 'title');
    expect(omp.parse(jsonl(lines), '/x/o-1.jsonl').title).toBe('New branch question');
  });
});

describe('omp files', () => {
  test('lists <agent dir>/sessions/<dir>/*.jsonl, honouring PI_CODING_AGENT_DIR', () => {
    const home = tempDir('omp-files');
    try {
      const agentDir = join(home, 'agent-alt');
      writeJsonl(join(agentDir, 'sessions', '-work-beta', '2026_o-1.jsonl'), ompSession());
      expect(omp.files({ home, env: { PI_CODING_AGENT_DIR: agentDir } })).toEqual([
        join(agentDir, 'sessions', '-work-beta', '2026_o-1.jsonl'),
      ]);
    } finally {
      cleanup(home);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/omp.test.js`
Expected: FAIL，找不到 `../src/sources/omp.mjs`。

- [ ] **Step 3: 写实现**

`src/sources/omp.mjs`：

```js
import { basename, join } from 'node:path';
import { finalizeContent, makeTitle, parseJsonLines } from '../filter.mjs';
import { jsonlInSubdirs } from './files.mjs';

export const platform = 'omp';
export const agentName = 'omp';

export function files({ home, env }) {
  return jsonlInSubdirs(join(env.PI_CODING_AGENT_DIR || join(home, '.omp', 'agent'), 'sessions'));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Root-to-leaf entries of the branch ending at the last physical entry (how omp rebuilds its leaf). */
function activeBranch(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path = [];
  const seen = new Set();
  let entry = entries.at(-1);
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    path.push(entry);
    entry = typeof entry.parentId === 'string' ? byId.get(entry.parentId) : undefined;
  }
  return path.reverse();
}

export function parse(text, file) {
  let slotTitle = null;
  let header = null;
  const entries = [];
  for (const line of parseJsonLines(text)) {
    if (line.type === 'title') {
      if (typeof line.title === 'string') slotTitle = line.title;
      continue;
    }
    if (line.type === 'session') {
      header ??= line;
      continue;
    }
    if (typeof line.id === 'string') entries.push(line);
  }
  const messages = [];
  for (const entry of activeBranch(entries)) {
    if (entry.type !== 'message') continue;
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const raw = textOf(entry.message.content);
    if (raw === null) continue;
    const content = finalizeContent(raw);
    if (content === '') continue;
    messages.push({ id: entry.id, role, content, occurredAt: typeof entry.timestamp === 'string' ? entry.timestamp : null });
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    platform,
    id: typeof header?.id === 'string' ? header.id : basename(file, '.jsonl'),
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    gitRemote: null,
    gitBranch: null,
    toolVersion: null,
    title: makeTitle(slotTitle) ?? makeTitle(header?.title) ?? makeTitle(firstUser?.content),
    startedAt: messages[0]?.occurredAt ?? (typeof header?.timestamp === 'string' ? header.timestamp : null),
    messages,
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/omp.test.js`
Expected: PASS。

- [ ] **Step 5: 用真实文件核对**

Run:

```bash
node --input-type=module -e "
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as o from './src/sources/omp.mjs';
const files = o.files({ home: homedir(), env: process.env }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 3);
for (const f of files) { const s = o.parse(readFileSync(f, 'utf8'), f); console.log(s.id, s.messages.length, s.messages.map(m => m.role).join(','), '|', s.title); }
"
```

Expected: 角色序列只有 `user` 与 `assistant`；条数远少于文件行数（工具结果已丢弃）。

- [ ] **Step 6: 提交**

```bash
git add src/sources/omp.mjs test/omp.test.js
git commit -m "Add omp session reader"
```

---

### Task 5: Codex 读取器

**Files:**
- Create: `src/sources/codex.mjs`、`test/codex.test.js`

**Interfaces:**
- Consumes: `parseJsonLines`、`finalizeContent`、`makeTitle`（Task 2）；`filesAtDepth`（Task 3）
- Produces: 读取器模块 `platform = 'codex'`、`agentName = 'Codex'`、`files({ home, env })`、`parse(text, file)`（非用户线程返回 `null`）、`isInjected(text: string): boolean`

- [ ] **Step 1: 写失败的测试**

`test/codex.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as codex from '../src/sources/codex.mjs';
import { codexSession } from './fixtures.js';
import { cleanup, jsonl, tempDir, writeJsonl } from './helpers.js';

describe('codex parse', () => {
  const session = codex.parse(jsonl(codexSession()), '/x/rollout-x-1.jsonl');

  test('keeps user input_text and assistant output_text, without injected context', () => {
    expect(session.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['msg_u1', 'user', 'Review the open PRs'],
      ['msg_a1', 'assistant', 'Found six open PRs.'],
    ]);
  });

  test('takes session fields from session_meta', () => {
    expect(session).toMatchObject({
      platform: 'codex', id: 'x-1', cwd: '/work/gamma', gitBranch: 'main', toolVersion: '0.163.0',
      gitRemote: 'git@github.com:JianyueLab/gamma.git', title: 'Review the open PRs',
    });
  });

  test('subagent and guardian threads are not sessions', () => {
    expect(codex.parse(jsonl(codexSession('x-2', '/w', 'guardian_review')), '/x/r.jsonl')).toBeNull();
    expect(codex.parse(jsonl(codexSession('x-3', '/w', 'subagent')), '/x/r.jsonl')).toBeNull();
  });

  test('a message without payload.id gets a stable 32-hex id', () => {
    const lines = codexSession().map((l) => (l.payload?.id === 'msg_u1' ? { ...l, payload: { ...l.payload, id: undefined } } : l));
    const a = codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].id;
    const b = codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].id;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
  });

  test('keeps the non-injected blocks of a mixed user message', () => {
    const lines = codexSession().map((l) =>
      l.payload?.id === 'msg_u1'
        ? { ...l, payload: { ...l.payload, content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }, { type: 'input_text', text: 'Real question' }] } }
        : l,
    );
    expect(codex.parse(jsonl(lines), '/x/r.jsonl').messages[0].content).toBe('Real question');
  });
});

describe('isInjected', () => {
  test('matches AGENTS.md blocks and whole-tag blocks only', () => {
    expect(codex.isInjected('# AGENTS.md instructions\n\nx')).toBe(true);
    expect(codex.isInjected(' <user_instructions>\nx\n</user_instructions> ')).toBe(true);
    expect(codex.isInjected('<b>bold</b> and more')).toBe(false);
    expect(codex.isInjected('Please fix <div> layout')).toBe(false);
  });
});

describe('codex files', () => {
  test('lists sessions/YYYY/MM/DD/rollout-*.jsonl, honouring CODEX_HOME', () => {
    const home = tempDir('codex-files');
    try {
      const root = join(home, 'codex-alt');
      const file = join(root, 'sessions', '2026', '10', '27', 'rollout-2026-10-27T03-00-00-x-1.jsonl');
      writeJsonl(file, codexSession());
      writeJsonl(join(root, 'sessions', '2026', '10', 'stray.jsonl'), codexSession());
      expect(codex.files({ home, env: { CODEX_HOME: root } })).toEqual([file]);
    } finally {
      cleanup(home);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/codex.test.js`
Expected: FAIL，找不到 `../src/sources/codex.mjs`。

- [ ] **Step 3: 写实现**

`src/sources/codex.mjs`：

```js
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { finalizeContent, makeTitle, parseJsonLines } from '../filter.mjs';
import { filesAtDepth } from './files.mjs';

export const platform = 'codex';
export const agentName = 'Codex';

const WHOLE_TAG_BLOCK = /^<([a-z_][a-z0-9_ ]*)>[\s\S]*<\/\1>$/;

export function files({ home, env }) {
  return filesAtDepth(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), 3, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
}

/** Context Codex injects as user input: the AGENTS.md block and whole `<tag>…</tag>` blocks. */
export function isInjected(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('# AGENTS.md instructions') || WHOLE_TAG_BLOCK.test(trimmed);
}

function isUserThread(meta) {
  if (typeof meta.thread_source === 'string') return meta.thread_source === 'user';
  return !(meta.source && typeof meta.source === 'object' && 'subagent' in meta.source);
}

const str = (value) => (typeof value === 'string' && value !== '' ? value : null);

export function parse(text, file) {
  let meta = null;
  const messages = [];
  for (const line of parseJsonLines(text)) {
    if (line.type === 'session_meta') {
      meta ??= line.payload && typeof line.payload === 'object' ? line.payload : null;
      continue;
    }
    if (line.type !== 'response_item') continue;
    const item = line.payload;
    if (item?.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const want = item.role === 'user' ? 'input_text' : 'output_text';
    const blocks = Array.isArray(item.content)
      ? item.content.filter((b) => b && b.type === want && typeof b.text === 'string').map((b) => b.text)
      : [];
    const kept = item.role === 'user' ? blocks.filter((b) => !isInjected(b)) : blocks;
    if (kept.length === 0) continue;
    const raw = kept.join('\n\n');
    const content = finalizeContent(raw);
    if (content === '') continue;
    const occurredAt = str(line.timestamp);
    const id = str(item.id) ?? createHash('sha256').update(`${occurredAt ?? ''}\n${item.role}\n${raw}`).digest('hex').slice(0, 32);
    messages.push({ id, role: item.role, content, occurredAt });
  }
  if (!meta || !isUserThread(meta)) return null;
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    platform,
    id: str(meta.id) ?? basename(file, '.jsonl'),
    cwd: str(meta.cwd),
    gitRemote: str(meta.git?.repository_url),
    gitBranch: str(meta.git?.branch),
    toolVersion: str(meta.cli_version),
    title: makeTitle(firstUser?.content),
    startedAt: messages[0]?.occurredAt ?? str(meta.timestamp),
    messages,
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/codex.test.js`
Expected: PASS。

- [ ] **Step 5: 用真实文件核对**

Run:

```bash
node --input-type=module -e "
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as x from './src/sources/codex.mjs';
const files = x.files({ home: homedir(), env: process.env }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 15);
let kept = 0, skipped = 0;
for (const f of files) { const s = x.parse(readFileSync(f, 'utf8'), f); if (!s) { skipped++; continue; } kept++; console.log(s.id, s.messages.length, s.messages.map(m => m.role).join(','), '|', s.title); }
console.log({ kept, skipped });
"
```

Expected: guardian 与子 agent 线程计入 `skipped`；保留的会话首条用户消息不是 AGENTS.md 或 `<environment_context>`。若出现新的注入块形状，把它加进 `test/codex.test.js` 的 `isInjected` 用例后再改规则。

- [ ] **Step 6: 提交**

```bash
git add src/sources/codex.mjs test/codex.test.js
git commit -m "Add Codex session reader"
```

---

### Task 6: 会话发现

**Files:**
- Create: `src/sources/index.mjs`、`test/discover.test.js`

**Interfaces:**
- Consumes: 三个读取器（Task 3–5）；`scrub`（Task 2）
- Produces:
  - `SOURCES`
  - `discover({ home, env?, now?, days?, gitRemote?, sources? }): Session[]`：按 `updatedAt` 倒序，每个 Session 带 `updatedAt`
  - `sessionKey(session): string`
  - `agentNameFor(platform: string): string`
  - `gitRemoteOf(cwd: string|null): string|null`

- [ ] **Step 1: 写失败的测试**

`test/discover.test.js`：

```js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { agentNameFor, discover, sessionKey } from '../src/sources/index.mjs';
import { claudeSession, codexSession, ompSession } from './fixtures.js';
import { cleanup, tempDir, writeJsonl } from './helpers.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ago = (hours) => new Date(NOW - hours * 3_600_000);

describe('discover', () => {
  let home;
  let remoteCalls;
  const gitRemote = (cwd) => {
    remoteCalls.push(cwd);
    return `https://ci:hunter22pass@git.example.com${cwd}.git`;
  };

  beforeEach(() => {
    home = tempDir('discover');
    remoteCalls = [];
    writeJsonl(join(home, '.claude/projects/-work-alpha/c-1.jsonl'), claudeSession('c-1'), ago(1));
    writeJsonl(join(home, '.claude/projects/-work-alpha/c-2.jsonl'), claudeSession('c-2'), ago(5));
    writeJsonl(join(home, '.claude/projects/-work-alpha/c-old.jsonl'), claudeSession('c-old'), ago(24 * 40));
    writeJsonl(join(home, '.claude/projects/-work-alpha/c-empty.jsonl'), claudeSession('c-empty').filter((l) => l.type !== 'user'), ago(1));
    writeJsonl(join(home, '.omp/agent/sessions/-work-beta/2026_o-1.jsonl'), ompSession('o-1'), ago(2));
    writeJsonl(join(home, '.codex/sessions/2026/10/27/rollout-a-x-1.jsonl'), codexSession('x-1'), ago(3));
    writeJsonl(join(home, '.codex/sessions/2026/10/27/rollout-b-x-2.jsonl'), codexSession('x-2', '/w', 'guardian_review'), ago(3));
  });

  afterEach(() => cleanup(home));

  test('returns sessions with a user message from the last 30 days, newest first', () => {
    const keys = discover({ home, env: {}, now: NOW, gitRemote }).map(sessionKey);
    expect(keys).toEqual(['claude-code:c-1', 'omp:o-1', 'codex:x-1', 'claude-code:c-2']);
  });

  test('--days widens the window', () => {
    const keys = discover({ home, env: {}, now: NOW, days: 60, gitRemote }).map(sessionKey);
    expect(keys).toContain('claude-code:c-old');
  });

  test('sets updatedAt from the file mtime', () => {
    const [first] = discover({ home, env: {}, now: NOW, gitRemote });
    expect(first.updatedAt).toBe(ago(1).toISOString());
  });

  test('looks up a git remote once per cwd, scrubbed; Codex keeps its own', () => {
    const sessions = discover({ home, env: {}, now: NOW, gitRemote });
    expect(remoteCalls.sort()).toEqual(['/work/alpha', '/work/beta']);
    const byKey = Object.fromEntries(sessions.map((s) => [sessionKey(s), s.gitRemote]));
    expect(byKey['claude-code:c-1']).toBe('https://[REDACTED:url_credential]@git.example.com/work/alpha.git');
    expect(byKey['codex:x-1']).toBe('git@github.com:JianyueLab/gamma.git');
  });

  test('agentNameFor maps platforms to display names', () => {
    expect(['claude-code', 'omp', 'codex'].map(agentNameFor)).toEqual(['Claude Code', 'omp', 'Codex']);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/discover.test.js`
Expected: FAIL，找不到 `../src/sources/index.mjs`。

- [ ] **Step 3: 写实现**

`src/sources/index.mjs`：

```js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { scrub } from '../scrub.mjs';
import * as claudeCode from './claude-code.mjs';
import * as codex from './codex.mjs';
import * as omp from './omp.mjs';

export const SOURCES = [claudeCode, omp, codex];
const DAY_MS = 86_400_000;

export function sessionKey(session) {
  return `${session.platform}:${session.id}`;
}

export function agentNameFor(platform) {
  return SOURCES.find((s) => s.platform === platform)?.agentName ?? platform;
}

/** `remote.origin.url` of the repository at `cwd`, or null. */
export function gitRemoteOf(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return url === '' ? null : url;
  } catch {
    return null;
  }
}

/**
 * Sessions whose file changed within `days`, with at least one user message, newest first.
 * When several files carry the same key, the newest file wins.
 */
export function discover({ home, env = {}, now = Date.now(), days = 30, gitRemote = gitRemoteOf, sources = SOURCES }) {
  const cutoff = now - days * DAY_MS;
  const remotes = new Map();
  const byKey = new Map();
  for (const source of sources) {
    for (const file of source.files({ home, env })) {
      let mtimeMs;
      let text;
      try {
        mtimeMs = statSync(file).mtimeMs;
        if (mtimeMs < cutoff) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const session = source.parse(text, file);
      if (!session || !session.messages.some((m) => m.role === 'user')) continue;
      session.updatedAt = new Date(mtimeMs).toISOString();
      if (session.gitRemote === null && session.cwd) {
        if (!remotes.has(session.cwd)) remotes.set(session.cwd, gitRemote(session.cwd));
        session.gitRemote = remotes.get(session.cwd);
      }
      if (session.gitRemote) session.gitRemote = scrub(session.gitRemote);
      const key = sessionKey(session);
      const previous = byKey.get(key);
      if (!previous || previous.updatedAt < session.updatedAt) byKey.set(key, session);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/discover.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sources/index.mjs test/discover.test.js
git commit -m "Add session discovery across Claude Code, omp and Codex"
```

---

### Task 7: 本地状态与锁

**Files:**
- Create: `src/state.mjs`、`test/state.test.js`

**Interfaces:**
- Produces:
  - `StateError`
  - `LOCK_STALE_MS = 60000`
  - `statePath(env, home): string`
  - `loadState(path): { version: 1, sessions: Record<string, Record> }`
  - `saveState(path, state): void`
  - `withLock(dir, fn, { now?, waitMs?, sleep? }?): Promise<any>`
  - `unsentMessages(session, record|undefined): Message[]`
  - `isListed(session, record|undefined, includeSkipped: boolean): boolean`
- Record：`{ decision: 'sent'|'skipped', project_id?, visibility?, conversation_id?, revision?, sent_message_ids: string[], updated_at: string }`

- [ ] **Step 1: 写失败的测试**

`test/state.test.js`：

```js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_STALE_MS, StateError, isListed, loadState, saveState, statePath, unsentMessages, withLock } from '../src/state.mjs';
import { cleanup, tempDir } from './helpers.js';

const session = { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] };

describe('state file', () => {
  let dir;
  beforeEach(() => { dir = tempDir('state'); });
  afterEach(() => cleanup(dir));

  test('statePath honours XDG_STATE_HOME', () => {
    expect(statePath({ XDG_STATE_HOME: '/s' }, '/h')).toBe('/s/jyl-memory/state.json');
    expect(statePath({}, '/h')).toBe('/h/.local/state/jyl-memory/state.json');
  });

  test('a missing file is an empty state', () => {
    expect(loadState(join(dir, 'none.json'))).toEqual({ version: 1, sessions: {} });
  });

  test('save then load round-trips with mode 0600', () => {
    const path = join(dir, 'jyl-memory', 'state.json');
    const state = { version: 1, sessions: { 'omp:a': { decision: 'skipped', sent_message_ids: [], updated_at: 't' } } };
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('invalid JSON and unknown versions are errors, not silent resets', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{nope');
    expect(() => loadState(bad)).toThrow(StateError);
    writeFileSync(bad, JSON.stringify({ version: 2, sessions: {} }));
    expect(() => loadState(bad)).toThrow(StateError);
  });
});

describe('pending', () => {
  test('a new session lists every message', () => {
    expect(unsentMessages(session, undefined).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(isListed(session, undefined, false)).toBe(true);
  });

  test('a fully sent session is not listed; new messages bring it back', () => {
    const all = { decision: 'sent', sent_message_ids: ['m1', 'm2', 'm3'] };
    const partial = { decision: 'sent', sent_message_ids: ['m1', 'm2'] };
    expect(isListed(session, all, false)).toBe(false);
    expect(isListed(session, partial, false)).toBe(true);
    expect(unsentMessages(session, partial).map((m) => m.id)).toEqual(['m3']);
  });

  test('a skipped session is listed only with includeSkipped', () => {
    const skipped = { decision: 'skipped', sent_message_ids: [] };
    expect(isListed(session, skipped, false)).toBe(false);
    expect(isListed(session, skipped, true)).toBe(true);
  });
});

describe('withLock', () => {
  let dir;
  beforeEach(() => { dir = tempDir('lock'); });
  afterEach(() => cleanup(dir));

  test('runs fn and removes the lock', async () => {
    expect(await withLock(dir, async () => 42)).toBe(42);
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  test('removes the lock when fn throws', async () => {
    await expect(withLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  test('a held lock fails after waitMs', async () => {
    writeFileSync(join(dir, 'lock'), '');
    await expect(withLock(dir, async () => 1, { waitMs: 0 })).rejects.toThrow(StateError);
  });

  test('a stale lock is taken over', async () => {
    const lock = join(dir, 'lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(lock, old, old);
    expect(await withLock(dir, async () => 'ok', { waitMs: 0 })).toBe('ok');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/state.test.js`
Expected: FAIL，找不到 `../src/state.mjs`。

- [ ] **Step 3: 写实现**

`src/state.mjs`：

```js
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class StateError extends Error {}

export const LOCK_STALE_MS = 60_000;

export function statePath(env, home) {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'jyl-memory', 'state.json');
}

export function loadState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sessions: {} };
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StateError(`state file is not valid JSON: ${path}`);
  }
  if (!data || data.version !== 1 || typeof data.sessions !== 'object' || data.sessions === null) {
    throw new StateError(`state file has an unknown format: ${path}`);
  }
  return data;
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Runs `fn` while holding `<dir>/lock`. A lock older than LOCK_STALE_MS is taken over. */
export async function withLock(dir, fn, { now = Date.now, waitMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'lock');
  const deadline = now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (now() >= deadline) throw new StateError('another jyl-memory run holds the lock');
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Messages not yet uploaded, in session order. Ignores the decision. */
export function unsentMessages(session, record) {
  const sent = new Set(record?.sent_message_ids ?? []);
  return session.messages.filter((m) => !sent.has(m.id));
}

/** Whether `list` shows the session. */
export function isListed(session, record, includeSkipped) {
  if (record?.decision === 'skipped') return includeSkipped;
  return unsentMessages(session, record).length > 0;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/state.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/state.mjs test/state.test.js
git commit -m "Add local state file and lock"
```

---

### Task 8: 配置与 Token

**Files:**
- Create: `src/config.mjs`、`test/config.test.js`

**Interfaces:**
- Produces:
  - `ConfigError`
  - `DEFAULT_BASE_URL`、`TOKEN_PATTERN`
  - `configPath(env, home): string`
  - `normalizeBaseUrl(value: string): string`
  - `loadConfig({ env, home }): { path, baseUrl, baseUrlSource: 'env'|'file'|'default', token: string|null, tokenSource: 'env'|'file'|null }`
  - `saveToken({ env, home }, token: string): string`（返回配置文件路径）
  - `tokenPrefix(token: string|null): string|null`

- [ ] **Step 1: 写失败的测试**

`test/config.test.js`：

```js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, DEFAULT_BASE_URL, configPath, loadConfig, normalizeBaseUrl, saveToken, tokenPrefix } from '../src/config.mjs';
import { cleanup, tempDir } from './helpers.js';

const token = (c = 'A') => `${'mem'}_${c.repeat(43)}`;

describe('config', () => {
  let home;
  beforeEach(() => { home = tempDir('config'); });
  afterEach(() => cleanup(home));

  test('defaults: production URL, no token', () => {
    expect(loadConfig({ env: {}, home })).toMatchObject({ baseUrl: DEFAULT_BASE_URL, baseUrlSource: 'default', token: null, tokenSource: null });
  });

  test('environment beats the file', () => {
    const path = configPath({}, home);
    mkdirSync(join(home, '.config', 'jyl-memory'), { recursive: true });
    writeFileSync(path, JSON.stringify({ base_url: 'https://file.example.com/', token: token('F') }));
    expect(loadConfig({ env: {}, home })).toMatchObject({ baseUrl: 'https://file.example.com', baseUrlSource: 'file', token: token('F'), tokenSource: 'file' });
    expect(loadConfig({ env: { JYL_MEMORY_URL: 'https://env.example.com', JYL_MEMORY_TOKEN: token('E') }, home })).toMatchObject({
      baseUrl: 'https://env.example.com', baseUrlSource: 'env', token: token('E'), tokenSource: 'env',
    });
  });

  test('a token that is not a mem_ agent token is rejected', () => {
    expect(() => loadConfig({ env: { JYL_MEMORY_TOKEN: 'jyl-abc' }, home })).toThrow(ConfigError);
  });

  test('saveToken writes 0600 and keeps other keys', () => {
    const path = configPath({}, home);
    mkdirSync(join(home, '.config', 'jyl-memory'), { recursive: true });
    writeFileSync(path, JSON.stringify({ base_url: 'https://keep.example.com' }));
    expect(saveToken({ env: {}, home }, `  ${token('S')}\n`)).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ base_url: 'https://keep.example.com', token: token('S') });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('saveToken rejects anything else', () => {
    expect(() => saveToken({ env: {}, home }, 'not-a-token')).toThrow(ConfigError);
  });

  test('tokenPrefix shows 12 characters only', () => {
    expect(tokenPrefix(token('P'))).toBe('mem_PPPPPPPP');
    expect(tokenPrefix(null)).toBeNull();
  });
});

describe('normalizeBaseUrl', () => {
  test('https and local http are accepted; a trailing slash is dropped', () => {
    expect(normalizeBaseUrl('https://m.example.com/')).toBe('https://m.example.com');
    expect(normalizeBaseUrl('http://localhost:4321')).toBe('http://localhost:4321');
  });

  test('remote http, credentials and queries are rejected', () => {
    for (const bad of ['http://m.example.com', 'https://u:p@m.example.com', 'https://m.example.com/?a=1', 'nope']) {
      expect(() => normalizeBaseUrl(bad)).toThrow(ConfigError);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/config.test.js`
Expected: FAIL，找不到 `../src/config.mjs`。

- [ ] **Step 3: 写实现**

`src/config.mjs`：

```js
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://memory.jianyuelab.co';
export const TOKEN_PATTERN = /^mem_[A-Za-z0-9_-]{43}$/;

export class ConfigError extends Error {}

export function configPath(env, home) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'jyl-memory', 'config.json');
}

function readConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError(`config file is not valid JSON: ${path}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`config file must hold a JSON object: ${path}`);
  return data;
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('base_url must be an absolute URL');
  }
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !local) throw new ConfigError('base_url must use https');
  if (url.username || url.password || url.search || url.hash) throw new ConfigError('base_url must not contain credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}

export function loadConfig({ env, home }) {
  const path = configPath(env, home);
  const file = readConfigFile(path);
  const envUrl = env.JYL_MEMORY_URL?.trim() || null;
  const envToken = env.JYL_MEMORY_TOKEN?.trim() || null;
  const fileUrl = typeof file.base_url === 'string' && file.base_url.trim() !== '' ? file.base_url.trim() : null;
  const fileToken = typeof file.token === 'string' && file.token.trim() !== '' ? file.token.trim() : null;
  const token = envToken ?? fileToken;
  const tokenSource = envToken ? 'env' : fileToken ? 'file' : null;
  if (token !== null && !TOKEN_PATTERN.test(token)) throw new ConfigError(`token from ${tokenSource} is not a mem_ agent token`);
  return {
    path,
    baseUrl: normalizeBaseUrl(envUrl ?? fileUrl ?? DEFAULT_BASE_URL),
    baseUrlSource: envUrl ? 'env' : fileUrl ? 'file' : 'default',
    token,
    tokenSource,
  };
}

export function saveToken({ env, home }, token) {
  const value = token.trim();
  if (!TOKEN_PATTERN.test(value)) throw new ConfigError('expected a mem_ agent token');
  const path = configPath(env, home);
  const data = { ...readConfigFile(path), token: value };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function tokenPrefix(token) {
  return token ? token.slice(0, 12) : null;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/config.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config.mjs test/config.test.js
git commit -m "Add config and token storage"
```

---

### Task 9: 上传

**Files:**
- Create: `src/upload.mjs`、`test/upload.test.js`

**Interfaces:**
- Consumes: `Session`、`Message`
- Produces:
  - `UploadError`（`scope: 'all'|'session'`、`status: number|null`、`code: string|null`）
  - 常量 `MAX_BATCH_MESSAGES`、`MAX_BATCH_BYTES`、`REQUEST_TIMEOUT_MS`、`RETRY_DELAYS_MS`
  - `buildBody(session, { projectId, visibility, device, captureVersion, agentName }): object`
  - `toWireMessage(message): object`
  - `batches(body, messages): Message[][]`
  - `postConversation({ baseUrl, token, body, fetchImpl?, sleep? }): Promise<{ conversationId, revision }>`
  - `uploadSession({ baseUrl, token, body, messages, fetchImpl?, sleep?, onBatch }): Promise<{ conversationId, revision }>`；`onBatch({ conversationId, revision, messageIds })`
  - `listProjects({ baseUrl, token, fetchImpl? }): Promise<Array<{ id, name, kind, role, writable }>>`

- [ ] **Step 1: 写失败的测试**

`test/upload.test.js`：

```js
import { describe, expect, test } from 'bun:test';
import { MAX_BATCH_BYTES, UploadError, batches, buildBody, listProjects, postConversation, uploadSession } from '../src/upload.mjs';

const session = {
  platform: 'omp', id: 'o-1', cwd: '/work/beta', gitRemote: null, gitBranch: 'main', toolVersion: null,
  title: 'Beta work', startedAt: '2026-10-27T02:00:03.000Z', messages: [],
};
const opts = { projectId: 'p1', visibility: 'private', device: 'laptop', captureVersion: '27.0.0', agentName: 'omp' };
const msg = (i, size = 5) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(size), occurredAt: null });
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

describe('buildBody', () => {
  test('private uploads carry model_consent; metadata omits empty fields', () => {
    expect(buildBody(session, opts)).toEqual({
      project_id: 'p1', source_platform: 'omp', source_conversation_id: 'o-1', visibility: 'private',
      agent_label: 'omp', device: 'laptop', title: 'Beta work', occurred_at: '2026-10-27T02:00:03.000Z',
      metadata: { cwd: '/work/beta', git_branch: 'main', capture_version: '27.0.0' },
      participants: [{ display_name: 'user', type: 'human' }, { display_name: 'omp', type: 'agent' }],
      model_consent: true,
    });
  });

  test('project visibility does not send model_consent', () => {
    expect(buildBody(session, { ...opts, visibility: 'project' })).not.toHaveProperty('model_consent');
  });
});

describe('batches', () => {
  test('splits at 1000 messages', () => {
    const messages = Array.from({ length: 2500 }, (_, i) => msg(i));
    expect(batches(buildBody(session, opts), messages).map((b) => b.length)).toEqual([1000, 1000, 500]);
  });

  test('splits before 8 MiB', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i, 400_000));
    const out = batches(buildBody(session, opts), messages);
    expect(out.length).toBeGreaterThan(1);
    for (const batch of out) {
      const size = Buffer.byteLength(JSON.stringify({ ...buildBody(session, opts), messages: batch.map((m) => ({ source_message_id: m.id, role: m.role, content: m.content })) }));
      expect(size).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(out.flat().map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });
});

describe('postConversation', () => {
  const args = { baseUrl: 'https://m.example.com', token: 'mem_t', body: { a: 1 } };

  test('sends a bearer POST and returns ids', async () => {
    const { fetchImpl, calls } = fakeFetch([json(201, { conversation_id: 'c1', revision: 1, job_ids: [] })]);
    expect(await postConversation({ ...args, fetchImpl, sleep: async () => {} })).toEqual({ conversationId: 'c1', revision: 1 });
    expect(calls[0].url).toBe('https://m.example.com/api/v1/conversations');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe('Bearer mem_t');
  });

  test('retries 5xx with backoff, then succeeds', async () => {
    const sleeps = [];
    const { fetchImpl, calls } = fakeFetch([json(503, {}), json(200, { conversation_id: 'c1', revision: 2 })]);
    await postConversation({ ...args, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  test('gives up after 3 retries on network errors', async () => {
    const sleeps = [];
    const { fetchImpl, calls } = fakeFetch([new Error('x'), new Error('x'), new Error('x'), new Error('x')]);
    const error = await postConversation({ ...args, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } }).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ scope: 'session', code: 'network' });
    expect(calls.length).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test('401 stops everything without retrying', async () => {
    const { fetchImpl, calls } = fakeFetch([json(401, { error: { code: 'invalid_token', message: 'x' } })]);
    const error = await postConversation({ ...args, fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(error).toMatchObject({ scope: 'all', status: 401, code: 'invalid_token' });
    expect(calls.length).toBe(1);
  });

  test('409 stops the session and keeps the server code', async () => {
    const { fetchImpl } = fakeFetch([json(409, { error: { code: 'message_conflict', message: 'x' } })]);
    const error = await postConversation({ ...args, fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(error).toMatchObject({ scope: 'session', status: 409, code: 'message_conflict' });
  });
});

describe('uploadSession', () => {
  test('posts each batch and reports the uploaded ids after each one', async () => {
    const messages = Array.from({ length: 1500 }, (_, i) => msg(i));
    const { fetchImpl, calls } = fakeFetch([json(201, { conversation_id: 'c1', revision: 1 }), json(200, { conversation_id: 'c1', revision: 2 })]);
    const seen = [];
    const result = await uploadSession({
      baseUrl: 'https://m.example.com', token: 'mem_t', body: buildBody(session, opts), messages, fetchImpl, sleep: async () => {},
      onBatch: (b) => seen.push([b.revision, b.messageIds.length]),
    });
    expect(result).toEqual({ conversationId: 'c1', revision: 2 });
    expect(seen).toEqual([[1, 1000], [2, 500]]);
    expect(calls[0].body.messages[0]).toEqual({ source_message_id: 'm0', role: 'user', content: 'xxxxx' });
    expect(calls[1].body).not.toHaveProperty('expected_revision');
  });
});

describe('listProjects', () => {
  test('follows cursors and marks owner/editor projects writable', async () => {
    const { fetchImpl, calls } = fakeFetch([
      json(200, { items: [{ id: 'p1', name: 'My memory', kind: 'personal', role: 'owner' }], next_cursor: 'n1' }),
      json(200, { items: [{ id: 'p2', name: 'Core', kind: 'team', role: 'reader' }], next_cursor: null }),
    ]);
    const projects = await listProjects({ baseUrl: 'https://m.example.com', token: 'mem_t', fetchImpl });
    expect(projects).toEqual([
      { id: 'p1', name: 'My memory', kind: 'personal', role: 'owner', writable: true },
      { id: 'p2', name: 'Core', kind: 'team', role: 'reader', writable: false },
    ]);
    expect(calls[1].url).toBe('https://m.example.com/api/v1/projects?limit=100&cursor=n1');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/upload.test.js`
Expected: FAIL，找不到 `../src/upload.mjs`。

- [ ] **Step 3: 写实现**

`src/upload.mjs`：

```js
export const MAX_BATCH_MESSAGES = 1000;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `scope` 'all' stops every upload of the run; 'session' stops only the current session. */
export class UploadError extends Error {
  constructor(scope, status, code, message) {
    super(message);
    this.scope = scope;
    this.status = status;
    this.code = code;
  }
}

export function buildBody(session, { projectId, visibility, device, captureVersion, agentName }) {
  const metadata = Object.fromEntries(
    Object.entries({
      cwd: session.cwd,
      git_remote: session.gitRemote,
      git_branch: session.gitBranch,
      tool_version: session.toolVersion,
      capture_version: captureVersion,
    }).filter(([, value]) => typeof value === 'string' && value !== ''),
  );
  const body = {
    project_id: projectId,
    source_platform: session.platform,
    source_conversation_id: session.id,
    visibility,
    agent_label: agentName,
    device,
    metadata,
    participants: [
      { display_name: 'user', type: 'human' },
      { display_name: agentName, type: 'agent' },
    ],
  };
  if (session.title) body.title = session.title;
  if (session.startedAt) body.occurred_at = session.startedAt;
  if (visibility === 'private') body.model_consent = true;
  return body;
}

export function toWireMessage(message) {
  const wire = { source_message_id: message.id, role: message.role, content: message.content };
  if (message.occurredAt) wire.occurred_at = message.occurredAt;
  return wire;
}

/** Messages split into batches of at most MAX_BATCH_MESSAGES and MAX_BATCH_BYTES serialised with `body`. */
export function batches(body, messages) {
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...body, messages: [] }));
  const out = [];
  let current = [];
  let bytes = baseBytes;
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(toWireMessage(message))) + 1;
    if (current.length > 0 && (current.length >= MAX_BATCH_MESSAGES || bytes + size > MAX_BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = baseBytes;
    }
    current.push(message);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function errorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

export async function postConversation({ baseUrl, token, body, fetchImpl = fetch, sleep = defaultSleep }) {
  const url = `${baseUrl}/api/v1/conversations`;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new UploadError('session', null, 'network', 'network error after 3 retries');
    }
    if (response.ok) {
      const result = await response.json();
      return { conversationId: result.conversation_id, revision: result.revision };
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new UploadError('session', response.status, null, `server returned ${response.status} after 3 retries`);
    }
    const code = await errorCode(response);
    if (response.status === 401 || response.status === 403) {
      throw new UploadError('all', response.status, code, 'token rejected: check the token and its conversation:write scope');
    }
    if (response.status === 404) throw new UploadError('session', 404, code, "project is not in the token's project list");
    if (response.status === 409) throw new UploadError('session', 409, code, `local session differs from the uploaded conversation (${code ?? 'conflict'})`);
    if (response.status === 413) throw new UploadError('session', 413, code, 'payload too large');
    throw new UploadError('session', response.status, code, `upload rejected with ${response.status} (${code ?? 'unknown'})`);
  }
}

export async function uploadSession({ baseUrl, token, body, messages, fetchImpl = fetch, sleep = defaultSleep, onBatch }) {
  let last = null;
  for (const batch of batches(body, messages)) {
    last = await postConversation({ baseUrl, token, body: { ...body, messages: batch.map(toWireMessage) }, fetchImpl, sleep });
    await onBatch({ ...last, messageIds: batch.map((m) => m.id) });
  }
  return last;
}

export async function listProjects({ baseUrl, token, fetchImpl = fetch }) {
  const items = [];
  let cursor = null;
  do {
    const url = new URL(`${baseUrl}/api/v1/projects`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new UploadError('all', null, 'network', 'could not reach the memory service');
    }
    if (response.status === 401 || response.status === 403) {
      throw new UploadError('all', response.status, await errorCode(response), 'token rejected: check the token and its memory:read scope');
    }
    if (!response.ok) throw new UploadError('all', response.status, await errorCode(response), `project list failed with ${response.status}`);
    const page = await response.json();
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items.map((p) => ({ id: p.id, name: p.name, kind: p.kind, role: p.role, writable: p.role === 'owner' || p.role === 'editor' }));
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test test/upload.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/upload.mjs test/upload.test.js
git commit -m "Add conversation upload client"
```

---

### Task 10: CLI 命令

**Files:**
- Modify: `src/cli.mjs`（整体替换）
- Modify: `test/cli.test.js`（整体替换）

**Interfaces:**
- Consumes: Task 2–9 的全部导出
- Produces: `run(argv, overrides)`。`overrides` 可含 `env`、`home`、`fetch`、`now`、`hostname`、`stdout`、`stderr`、`readStdin`、`sleep`、`gitRemote`、`skillSource`。

- [ ] **Step 1: 写失败的测试**

`test/cli.test.js`（替换 Task 1 的版本）：

```js
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';
import { claudeSession, ompSession } from './fixtures.js';
import { cleanup, sink, tempDir, writeJsonl } from './helpers.js';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const TOKEN = `${'mem'}_${'T'.repeat(43)}`;
const PROJECTS = [
  { id: 'p-personal', name: 'My memory', kind: 'personal', role: 'owner' },
  { id: 'p-team', name: 'Core', kind: 'team', role: 'editor' },
  { id: 'p-read', name: 'Docs', kind: 'team', role: 'reader' },
];
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function server({ fail } = {}) {
  const posts = [];
  let revision = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/projects') return json(200, { items: PROJECTS, next_cursor: null });
    if (u.pathname === '/api/v1/conversations' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      const status = fail?.(body);
      if (status) return json(status, { error: { code: status === 409 ? 'message_conflict' : 'invalid_token', message: 'x' } });
      revision += 1;
      return json(revision === 1 ? 201 : 200, { conversation_id: `conv-${body.source_conversation_id}`, revision, job_ids: [] });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  return { fetchImpl, posts };
}

describe('cli', () => {
  let home;
  let stdout;
  let stderr;
  const deps = (extra = {}) => ({
    env: {}, home, now: () => NOW, hostname: 'laptop', stdout, stderr, sleep: async () => {}, gitRemote: () => null,
    readStdin: async () => '', ...extra,
  });
  const lastJson = () => JSON.parse(stdout.text().trim().split('\n').at(-1));

  beforeEach(() => {
    home = tempDir('cli');
    stdout = sink();
    stderr = sink();
    writeJsonl(join(home, '.claude/projects/-work-alpha/c-1.jsonl'), claudeSession('c-1'), new Date(NOW - 3_600_000));
    writeJsonl(join(home, '.omp/agent/sessions/-work-beta/2026_o-1.jsonl'), ompSession('o-1'), new Date(NOW - 7_200_000));
  });

  afterEach(() => cleanup(home));

  test('--version prints the package version and a newline (Homebrew test contract)', async () => {
    expect(await run(['--version'], deps())).toBe(0);
    expect(stdout.text()).toBe(`${PACKAGE_VERSION}\n`);
  });

  test('list --json in an empty home prints [] and a newline (Homebrew test contract)', async () => {
    const empty = tempDir('cli-empty');
    try {
      expect(await run(['list', '--json'], { ...deps(), home: empty })).toBe(0);
      expect(stdout.text()).toBe('[]\n');
    } finally {
      cleanup(empty);
    }
  });

  test('list --json describes waiting sessions, newest first', async () => {
    expect(await run(['list', '--json'], deps())).toBe(0);
    expect(lastJson()).toEqual([
      expect.objectContaining({ key: 'claude-code:c-1', tool: 'claude-code', cwd: '/work/alpha', title: 'Deploy question', pending_messages: 2, previously_sent: false, skipped: false }),
      expect.objectContaining({ key: 'omp:o-1', tool: 'omp', pending_messages: 2 }),
    ]);
  });

  test('projects needs a token', async () => {
    expect(await run(['projects'], deps())).toBe(2);
    expect(stderr.text()).toContain('jyl-memory config set-token');
  });

  test('projects --json lists writable projects only', async () => {
    const { fetchImpl } = server();
    expect(await run(['projects', '--json'], deps({ env: { JYL_MEMORY_TOKEN: TOKEN }, fetch: fetchImpl }))).toBe(0);
    expect(lastJson().map((p) => p.id)).toEqual(['p-personal', 'p-team']);
  });

  test('send uploads private with consent, records state, and a second send has nothing new', async () => {
    const { fetchImpl, posts } = server();
    const env = { JYL_MEMORY_TOKEN: TOKEN };
    expect(await run(['send', 'claude-code:c-1', '--project', 'p-personal', '--visibility', 'project', '--json'], deps({ env, fetch: fetchImpl }))).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ project_id: 'p-personal', visibility: 'private', model_consent: true, source_platform: 'claude-code', source_conversation_id: 'c-1', device: 'laptop', agent_label: 'Claude Code' });
    expect(posts[0].messages.map((m) => m.source_message_id)).toEqual(['u1', 'a3']);
    expect(lastJson()).toEqual([{ key: 'claude-code:c-1', status: 'sent', conversation_id: 'conv-c-1', url: 'https://memory.jianyuelab.co/conversations/conv-c-1', uploaded: 2 }]);

    stdout = sink();
    expect(await run(['send', 'claude-code:c-1', '--project', 'p-personal', '--json'], deps({ env, fetch: fetchImpl }))).toBe(0);
    expect(posts).toHaveLength(1);
    expect(lastJson()[0].status).toBe('nothing_new');

    stdout = sink();
    await run(['list', '--json'], deps());
    expect(lastJson().map((s) => s.key)).toEqual(['omp:o-1']);
  });

  test('send to a team project as project visibility omits model_consent', async () => {
    const { fetchImpl, posts } = server();
    expect(await run(['send', 'omp:o-1', '--project', 'p-team', '--visibility', 'project'], deps({ env: { JYL_MEMORY_TOKEN: TOKEN }, fetch: fetchImpl }))).toBe(0);
    expect(posts[0].visibility).toBe('project');
    expect(posts[0]).not.toHaveProperty('model_consent');
  });

  test('send refuses a read-only project and unknown keys with exit 2', async () => {
    const { fetchImpl, posts } = server();
    const env = { JYL_MEMORY_TOKEN: TOKEN };
    expect(await run(['send', 'omp:o-1', '--project', 'p-read'], deps({ env, fetch: fetchImpl }))).toBe(2);
    expect(await run(['send', 'omp:nope', '--project', 'p-team'], deps({ env, fetch: fetchImpl }))).toBe(2);
    expect(await run(['send', 'bogus', '--project', 'p-team'], deps({ env, fetch: fetchImpl }))).toBe(2);
    expect(posts).toHaveLength(0);
  });

  test('send refuses a different project for an already sent session', async () => {
    const { fetchImpl } = server();
    const env = { JYL_MEMORY_TOKEN: TOKEN };
    await run(['send', 'omp:o-1', '--project', 'p-personal'], deps({ env, fetch: fetchImpl }));
    expect(await run(['send', 'omp:o-1', '--project', 'p-team'], deps({ env, fetch: fetchImpl }))).toBe(2);
    expect(stderr.text()).toContain('was sent to project p-personal');
  });

  test('a 409 marks the session failed, exits 1 and keeps it pending', async () => {
    const { fetchImpl } = server({ fail: () => 409 });
    expect(await run(['send', 'omp:o-1', '--project', 'p-personal', '--json'], deps({ env: { JYL_MEMORY_TOKEN: TOKEN }, fetch: fetchImpl }))).toBe(1);
    expect(lastJson()[0]).toMatchObject({ key: 'omp:o-1', status: 'failed', http_status: 409, code: 'message_conflict', uploaded: 0 });
    stdout = sink();
    await run(['list', '--json'], deps());
    expect(lastJson().map((s) => s.key)).toContain('omp:o-1');
  });

  test('a 401 stops the run and reports the rest as not attempted', async () => {
    const { fetchImpl, posts } = server({ fail: () => 401 });
    expect(await run(['send', 'claude-code:c-1', 'omp:o-1', '--project', 'p-personal', '--json'], deps({ env: { JYL_MEMORY_TOKEN: TOKEN }, fetch: fetchImpl }))).toBe(1);
    expect(posts).toHaveLength(1);
    expect(lastJson().map((r) => r.status)).toEqual(['failed', 'not_attempted']);
  });

  test('skip hides a session; --include-skipped shows it', async () => {
    expect(await run(['skip', 'omp:o-1'], deps())).toBe(0);
    stdout = sink();
    await run(['list', '--json'], deps());
    expect(lastJson().map((s) => s.key)).toEqual(['claude-code:c-1']);
    stdout = sink();
    await run(['list', '--json', '--include-skipped'], deps());
    expect(lastJson().find((s) => s.key === 'omp:o-1')).toMatchObject({ skipped: true });
  });

  test('config set-token reads stdin; status reports it without the secret', async () => {
    expect(await run(['config', 'set-token'], deps({ readStdin: async () => `${TOKEN}\n` }))).toBe(0);
    const path = join(home, '.config/jyl-memory/config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    stdout = sink();
    expect(await run(['status', '--json'], deps())).toBe(0);
    const status = lastJson();
    expect(status).toMatchObject({ configured: true, token_prefix: 'mem_TTTTTTTT', token_source: 'file', base_url: 'https://memory.jianyuelab.co', sent: 0, skipped: 0 });
    expect(stdout.text()).not.toContain(TOKEN);
  });

  test('status without a token reports configured false', async () => {
    expect(await run(['status', '--json'], deps())).toBe(0);
    expect(lastJson().configured).toBe(false);
  });

  test('install-skill copies the skill into the Claude and Codex skill directories', async () => {
    const source = join(home, 'SKILL.md');
    writeFileSync(source, '---\nname: jyl-memory\n---\n');
    expect(await run(['install-skill'], deps({ skillSource: source, env: { CODEX_HOME: join(home, 'codex-alt') } }))).toBe(0);
    expect(existsSync(join(home, '.claude/skills/jyl-memory/SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'codex-alt/skills/jyl-memory/SKILL.md'))).toBe(true);
  });

  test('a corrupt state file is exit 2, not a silent reset', async () => {
    mkdirSync(join(home, '.local/state/jyl-memory'), { recursive: true });
    writeFileSync(join(home, '.local/state/jyl-memory/state.json'), '{nope');
    expect(await run(['list'], deps())).toBe(2);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test test/cli.test.js`
Expected: FAIL：`list`、`projects`、`send`、`skip`、`status`、`config`、`install-skill` 的用例返回 2 并输出 usage。

- [ ] **Step 3: 写实现**

`src/cli.mjs`（整体替换）：

```js
import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, saveToken, tokenPrefix } from './config.mjs';
import { agentNameFor, discover, sessionKey } from './sources/index.mjs';
import { StateError, isListed, loadState, saveState, statePath, unsentMessages, withLock } from './state.mjs';
import { UploadError, buildBody, listProjects, uploadSession } from './upload.mjs';
import { VERSION } from './version.mjs';

const USAGE = `usage: jyl-memory <command>
  list [--json] [--days N] [--include-skipped]
  projects [--json]
  send <key>... --project <id> [--visibility private|project] [--days N] [--json]
  skip <key>...
  status [--json]
  config set-token          reads the token from stdin
  install-skill
  --version`;

const KEY_PATTERN = /^(claude-code|omp|codex):.+$/;

class UsageError extends Error {}

function defaultDeps() {
  return {
    env: process.env,
    home: homedir(),
    fetch: globalThis.fetch,
    now: Date.now,
    hostname: hostname().split('.')[0],
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin: async () => {
      let text = '';
      for await (const chunk of process.stdin) text += chunk;
      return text;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    gitRemote: undefined,
    skillSource: fileURLToPath(new URL('../skill/SKILL.md', import.meta.url)),
  };
}

export async function run(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const out = (line) => deps.stdout.write(`${line}\n`);
  const err = (line) => deps.stderr.write(`${line}\n`);
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case '--version':
        out(VERSION);
        return 0;
      case 'list':
        return cmdList(rest, deps, out);
      case 'projects':
        return await cmdProjects(rest, deps, out);
      case 'send':
        return await cmdSend(rest, deps, out);
      case 'skip':
        return await cmdSkip(rest, deps, out);
      case 'status':
        return cmdStatus(rest, deps, out);
      case 'config':
        return await cmdConfig(rest, deps, out);
      case 'install-skill':
        return cmdInstallSkill(rest, deps, out);
      default:
        err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError || error instanceof StateError || String(error?.code).startsWith('ERR_PARSE_ARGS')) {
      err(`jyl-memory: ${error.message}`);
      return 2;
    }
    if (error instanceof UploadError) {
      err(`jyl-memory: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function parse(args, options, allowPositionals = false) {
  return parseArgs({ args, options, allowPositionals, strict: true });
}

function parseDays(value) {
  if (value === undefined) return 30;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new UsageError('--days must be a positive integer');
  return Number(value);
}

function parseKeys(positionals, command) {
  if (positionals.length === 0) throw new UsageError(`${command} needs at least one session key`);
  const bad = positionals.filter((key) => !KEY_PATTERN.test(key));
  if (bad.length > 0) throw new UsageError(`not a session key: ${bad.join(', ')}`);
  return [...new Set(positionals)];
}

function requireToken(config) {
  if (!config.token) {
    throw new ConfigError(`no token configured: issue one at ${config.baseUrl}/settings/agents and run \`jyl-memory config set-token\``);
  }
  return config;
}

function sessionsOf(deps, days) {
  return discover({ home: deps.home, env: deps.env, now: deps.now(), days, gitRemote: deps.gitRemote });
}

function cmdList(args, deps, out) {
  const { values } = parse(args, { json: { type: 'boolean' }, days: { type: 'string' }, 'include-skipped': { type: 'boolean' } });
  const state = loadState(statePath(deps.env, deps.home));
  const items = sessionsOf(deps, parseDays(values.days))
    .filter((s) => isListed(s, state.sessions[sessionKey(s)], values['include-skipped'] === true))
    .map((s) => {
      const record = state.sessions[sessionKey(s)];
      return {
        key: sessionKey(s),
        tool: s.platform,
        cwd: s.cwd,
        git_remote: s.gitRemote,
        started_at: s.startedAt,
        updated_at: s.updatedAt,
        title: s.title,
        pending_messages: unsentMessages(s, record).length,
        previously_sent: (record?.sent_message_ids?.length ?? 0) > 0,
        skipped: record?.decision === 'skipped',
      };
    });
  if (values.json) {
    out(JSON.stringify(items));
    return 0;
  }
  if (items.length === 0) {
    out('No sessions waiting.');
    return 0;
  }
  items.forEach((item, index) => {
    const where = item.cwd ? item.cwd.split('/').filter(Boolean).at(-1) : '-';
    const notes = [`${item.pending_messages} new`, item.previously_sent ? 'sent before' : null, item.skipped ? 'skipped' : null].filter(Boolean).join(', ');
    out(`${index + 1}. [${item.tool}] ${item.updated_at.slice(0, 16).replace('T', ' ')}  ${where}  ${item.title ?? '(untitled)'}  (${notes})`);
    out(`   ${item.key}`);
  });
  return 0;
}

async function cmdProjects(args, deps, out) {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const config = requireToken(loadConfig(deps));
  const projects = (await listProjects({ baseUrl: config.baseUrl, token: config.token, fetchImpl: deps.fetch })).filter((p) => p.writable);
  if (values.json) {
    out(JSON.stringify(projects));
    return 0;
  }
  if (projects.length === 0) {
    out('No writable projects for this token.');
    return 0;
  }
  projects.forEach((p, index) => out(`${index + 1}. ${p.name} (${p.kind})  ${p.id}`));
  return 0;
}

async function cmdSend(args, deps, out) {
  const { values, positionals } = parse(
    args,
    { project: { type: 'string' }, visibility: { type: 'string' }, days: { type: 'string' }, json: { type: 'boolean' } },
    true,
  );
  const keys = parseKeys(positionals, 'send');
  if (!values.project) throw new UsageError('send needs --project <id>');
  if (values.visibility !== undefined && values.visibility !== 'private' && values.visibility !== 'project') {
    throw new UsageError('--visibility must be private or project');
  }
  const config = requireToken(loadConfig(deps));
  const sessions = new Map(sessionsOf(deps, parseDays(values.days)).map((s) => [sessionKey(s), s]));
  const missing = keys.filter((key) => !sessions.has(key));
  if (missing.length > 0) throw new UsageError(`session not found (try a larger --days): ${missing.join(', ')}`);
  const projects = await listProjects({ baseUrl: config.baseUrl, token: config.token, fetchImpl: deps.fetch });
  const project = projects.find((p) => p.id === values.project);
  if (!project || !project.writable) throw new UsageError(`project ${values.project} is not writable with this token`);
  const visibility = project.kind === 'personal' ? 'private' : (values.visibility ?? 'private');

  const path = statePath(deps.env, deps.home);
  const results = [];
  await withLock(dirname(path), async () => {
    const state = loadState(path);
    for (const key of keys) {
      const record = state.sessions[key];
      if (record?.conversation_id && (record.project_id !== project.id || record.visibility !== visibility)) {
        throw new UsageError(`${key} was sent to project ${record.project_id} as ${record.visibility}; send it there again`);
      }
    }
    let stopAll = false;
    for (const key of keys) {
      if (stopAll) {
        results.push({ key, status: 'not_attempted' });
        continue;
      }
      const session = sessions.get(key);
      const messages = unsentMessages(session, state.sessions[key]);
      if (messages.length === 0) {
        results.push({ key, status: 'nothing_new', conversation_id: state.sessions[key]?.conversation_id ?? null, uploaded: 0 });
        continue;
      }
      const body = buildBody(session, {
        projectId: project.id,
        visibility,
        device: (deps.hostname || 'unknown').slice(0, 100),
        captureVersion: VERSION,
        agentName: agentNameFor(session.platform),
      });
      let uploaded = 0;
      try {
        const done = await uploadSession({
          baseUrl: config.baseUrl,
          token: config.token,
          body,
          messages,
          fetchImpl: deps.fetch,
          sleep: deps.sleep,
          onBatch: ({ conversationId, revision, messageIds }) => {
            const current = state.sessions[key];
            state.sessions[key] = {
              decision: 'sent',
              project_id: project.id,
              visibility,
              conversation_id: conversationId,
              revision,
              sent_message_ids: [...(current?.sent_message_ids ?? []), ...messageIds],
              updated_at: new Date(deps.now()).toISOString(),
            };
            saveState(path, state);
            uploaded += messageIds.length;
          },
        });
        results.push({ key, status: 'sent', conversation_id: done.conversationId, url: `${config.baseUrl}/conversations/${done.conversationId}`, uploaded });
      } catch (error) {
        if (!(error instanceof UploadError)) throw error;
        results.push({ key, status: 'failed', uploaded, error: error.message, http_status: error.status, code: error.code });
        if (error.scope === 'all') stopAll = true;
      }
    }
  });

  if (values.json) out(JSON.stringify(results));
  else {
    for (const r of results) {
      if (r.status === 'sent') out(`sent         ${r.key}  ${r.uploaded} messages  ${r.url}`);
      else if (r.status === 'nothing_new') out(`nothing new  ${r.key}`);
      else if (r.status === 'failed') out(`failed       ${r.key}  ${r.error}`);
      else out(`not tried    ${r.key}`);
    }
  }
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

async function cmdSkip(args, deps, out) {
  const { positionals } = parse(args, {}, true);
  const keys = parseKeys(positionals, 'skip');
  const path = statePath(deps.env, deps.home);
  await withLock(dirname(path), async () => {
    const state = loadState(path);
    for (const key of keys) {
      const previous = state.sessions[key];
      state.sessions[key] = { ...previous, decision: 'skipped', sent_message_ids: previous?.sent_message_ids ?? [], updated_at: new Date(deps.now()).toISOString() };
    }
    saveState(path, state);
  });
  out(`Skipped ${keys.length} session(s).`);
  return 0;
}

function cmdStatus(args, deps, out) {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const config = loadConfig(deps);
  const path = statePath(deps.env, deps.home);
  const records = Object.values(loadState(path).sessions);
  const status = {
    version: VERSION,
    configured: config.token !== null,
    base_url: config.baseUrl,
    base_url_source: config.baseUrlSource,
    token_prefix: tokenPrefix(config.token),
    token_source: config.tokenSource,
    config_path: config.path,
    state_path: path,
    sent: records.filter((r) => r.decision === 'sent').length,
    skipped: records.filter((r) => r.decision === 'skipped').length,
  };
  if (values.json) {
    out(JSON.stringify(status));
    return 0;
  }
  out(`jyl-memory ${status.version}`);
  out(`base_url   ${status.base_url} (${status.base_url_source})`);
  out(`token      ${status.configured ? `${status.token_prefix}… (${status.token_source})` : 'not configured'}`);
  out(`config     ${status.config_path}`);
  out(`state      ${status.state_path}`);
  out(`sessions   ${status.sent} sent, ${status.skipped} skipped`);
  return 0;
}

async function cmdConfig(args, deps, out) {
  if (args.length !== 1 || args[0] !== 'set-token') throw new UsageError('usage: jyl-memory config set-token  (the token is read from stdin)');
  const token = (await deps.readStdin()).trim();
  const path = saveToken(deps, token);
  out(`Saved token ${tokenPrefix(token)}… to ${path}`);
  return 0;
}

function cmdInstallSkill(args, deps, out) {
  parse(args, {});
  const targets = [
    join(deps.env.CLAUDE_CONFIG_DIR || join(deps.home, '.claude'), 'skills', 'jyl-memory', 'SKILL.md'),
    join(deps.env.CODEX_HOME || join(deps.home, '.codex'), 'skills', 'jyl-memory', 'SKILL.md'),
  ];
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(deps.skillSource, target);
    out(`Installed ${target}`);
  }
  return 0;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test`
Expected: 全部 PASS。

- [ ] **Step 5: 用 Node 冒烟**

Run:

```bash
mkdir -p .temp/empty-home && HOME="$PWD/.temp/empty-home" node bin/jyl-memory list --json && node bin/jyl-memory list --days 7 && node bin/jyl-memory status; rm -rf .temp/empty-home
```

Expected：第一行 `[]`；随后列出本机最近 7 天的会话（编号、工具、目录、标题、条数），然后输出状态。只看列表，不上传。

- [ ] **Step 6: 提交**

```bash
git add src/cli.mjs test/cli.test.js
git commit -m "Add list, projects, send, skip, status, config and install-skill commands"
```

---

### Task 11: `/jyl-memory` skill

**Files:**
- Create: `skill/SKILL.md`

**Interfaces:**
- Consumes: Task 10 的命令与 JSON 输出字段。

- [ ] **Step 1: 写 skill**

`skill/SKILL.md`：

```markdown
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
7. Report each `send` result: `sent` with `url` and `uploaded`; `nothing_new`; `failed` with `error`; `not_attempted`. Exit status 1 means at least one session failed; failed sessions stay in the list.
```

- [ ] **Step 2: 安装并检查**

Run: `node bin/jyl-memory install-skill && head -3 ~/.claude/skills/jyl-memory/SKILL.md ~/.codex/skills/jyl-memory/SKILL.md`
Expected: 两个文件都以 `---` 与 `name: jyl-memory` 开头。

- [ ] **Step 3: 在三个 agent 内确认 skill 可见**

在 Claude Code 中输入 `/jyl-memory`，在 Codex 中输入 `$jyl-memory`，在 omp 中让它「用 jyl-memory 列出待上传的会话」。
Expected: 三处都运行 `jyl-memory status --json` 与 `jyl-memory list --json`，并给出编号列表。此时不选择任何会话。

- [ ] **Step 4: 提交**

```bash
git add skill/SKILL.md
git commit -m "Add jyl-memory skill"
```

---

### Task 12: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README**

```markdown
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

- User and assistant text only. Tool calls, tool output, thinking, system and developer messages, injected context and subagent threads are dropped.
- Secrets matching known shapes are replaced with `[REDACTED:<type>]`. Unknown formats are not caught.
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
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "Add README"
```

---

### Task 13: 公开仓库与预发布 tag

需要用户确认后执行：在 GitHub 创建公开仓库。

**Files:** 无代码改动。

- [ ] **Step 1: 全量检查**

Run: `bun test && node --check bin/jyl-memory && node --check src/cli.mjs && git status --short`
Expected: 测试全过；`git status` 无输出。

- [ ] **Step 2: 确认仓库内没有真实会话内容或密钥**

Run: `git log -p | grep -nE 'sk-[A-Za-z0-9_-]{20}|mem_[A-Za-z0-9_-]{43}|gh[pousr]_[A-Za-z0-9]{30}|BEGIN [A-Z ]*PRIVATE KEY' || echo clean`
Expected: `clean`。

- [ ] **Step 3: 创建公开仓库并推送**

```bash
gh repo create JianyueLab/memory-capture --public --source . --remote origin --push \
  --description "Upload chosen Claude Code, omp and Codex sessions to JianyueLab memory"
```

- [ ] **Step 4: 打预发布 tag**

```bash
git tag v27.0.0
git push origin v27.0.0
```

---

### Task 14: Homebrew formula

**Files:**
- Create: `homebrew-internal/Formula/jyl-memory.rb`（`homebrew-internal` 仓库）

**Interfaces:**
- Consumes: Task 13 的 tag `v27.0.0`；Global Constraints 中的两条 `brew test` 契约。

- [ ] **Step 1: 计算 tarball 校验和**

Run: `curl -fsSL https://github.com/JianyueLab/memory-capture/archive/refs/tags/v27.0.0.tar.gz | shasum -a 256`
Expected: 一个 64 位十六进制值，下一步写入 `sha256`。

- [ ] **Step 2: 写 formula**

`homebrew-internal/Formula/jyl-memory.rb`（`sha256` 填上一步的值）：

```ruby
class JylMemory < Formula
  desc "Upload chosen Claude Code, omp and Codex sessions to JianyueLab memory"
  homepage "https://github.com/JianyueLab/memory-capture"
  url "https://github.com/JianyueLab/memory-capture/archive/refs/tags/v27.0.0.tar.gz"
  sha256 "<Step 1 的输出>"

  depends_on "node"

  def install
    libexec.install "package.json", "bin", "src", "skill"
    (bin/"jyl-memory").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/jyl-memory" "$@"
    SH
  end

  test do
    assert_equal "#{version}\n", shell_output("#{bin}/jyl-memory --version")
    ENV["HOME"] = testpath
    assert_equal "[]\n", shell_output("#{bin}/jyl-memory list --json")
  end
end
```

- [ ] **Step 3: 安装并测试**

Run: `brew install --build-from-source ./Formula/jyl-memory.rb && brew test ./Formula/jyl-memory.rb && jyl-memory --version`
（在 `homebrew-internal` 目录内运行）
Expected: 安装成功；`brew test` 通过；输出 `27.0.0`。

- [ ] **Step 4: 提交并推送**

```bash
git -C homebrew-internal add Formula/jyl-memory.rb
git -C homebrew-internal commit -m "Add jyl-memory formula 27.0.0"
git -C homebrew-internal push
```

- [ ] **Step 5: 从 tap 安装验证**

Run: `brew uninstall jyl-memory && brew update && brew install JianyueLab/internal/jyl-memory && jyl-memory install-skill`
Expected: 从 tap 安装成功，skill 写入两处。

---

### Task 15: 端到端冒烟与正式版

前置：`memory` 的 `model_consent` 改动已部署；部署端已开启提取（`EXTRACTION_*`、`EXTRACTION_ENABLED=true`）。

- [ ] **Step 1: 签发 Token 并配置**

在 `https://memory.jianyuelab.co/settings/agents` 签发 Token（scope `conversation:write`、`memory:read`），然后运行 `jyl-memory config set-token`。
Run: `jyl-memory status`
Expected: `token` 一行显示 `mem_` 前缀与 `(file)`。

- [ ] **Step 2: 在 agent 内上传一个会话**

在 Claude Code 中运行 `/jyl-memory`，选一个不含敏感内容的会话，项目选 My memory。
Expected: 结果为 `sent`，附网页地址。

- [ ] **Step 3: 在网页核对**

打开结果中的地址。
Expected:
- 消息只有用户与助手正文，没有工具输出。
- 「模型外发」显示已同意。
- 提取任务为 `queued` 或已完成。

- [ ] **Step 4: 追加与幂等**

在同一会话里再对话一轮，然后再次运行 `/jyl-memory`。
Expected: 该会话以 "sent before" 列出，待上传条数为新增的条数；上传后网页只多出这几条。

- [ ] **Step 5: 删除冒烟会话**

在网页删除该会话（预览后确认）。

- [ ] **Step 6: 发布正式版**

```bash
# memory-capture
npm pkg set version=27.1.0
git commit -am "Release 27.1.0"
git tag v27.1.0 && git push origin main v27.1.0
```

然后把 `homebrew-internal/Formula/jyl-memory.rb` 的 `url` 改为 `v27.1.0`，按 Task 14 Step 1 重算 `sha256`，运行 Task 14 Step 3，提交 `Update jyl-memory to 27.1.0` 并推送。

---

### Task 16: 工作区接入

**Files:**
- Modify: 工作区根仓库 `.gitmodules`、`CLAUDE.md`

- [ ] **Step 1: 加 submodule**

在工作区根目录运行：

```bash
mv memory-capture ../memory-capture.local
git submodule add git@github.com:JianyueLab/memory-capture.git memory-capture
diff -r ../memory-capture.local/src memory-capture/src && rm -rf ../memory-capture.local
```

Expected: `diff` 无输出（本地与 GitHub 内容一致）后删除本地副本。

- [ ] **Step 2: 更新根 `CLAUDE.md`**

- 首段的仓库数量 `twenty-five` 改为 `twenty-six`（共两处：首段与「every build/test command runs from inside one of the …」）。
- 仓库表在 `harness-plugin/` 行之后加一行：

```markdown
|`memory-capture/`|`JianyueLab/memory-capture` (**public**)|`jyl-memory` CLI and skill: lists local Claude Code, omp and Codex sessions; uploads the ones the user chooses to `memory` with a `mem_` agent token, after dropping tool output and scrubbing secrets. Zero-dependency Node ESM, `bun test`. Distributed by the `homebrew-internal` formula `jyl-memory`.|
```

- 「The other thirteen have none」改为「The other fourteen have none」。
- 「Working across repos」末尾加一条：

```markdown
- **`memory-capture` and `memory` are coupled by the REST contract `POST /api/v1/conversations`.** Installed clients update on their own schedule; a change to that request body breaks them. Additive changes only.
```

- 「Commands by repo」代码块加：

```bash
# memory-capture/ (no install, no dependencies)
bun test
node bin/jyl-memory list --days 7
```

- [ ] **Step 3: 提交**

```bash
git add .gitmodules memory-capture CLAUDE.md
git commit -m "Add memory-capture submodule"
```

根仓库是否推送由用户决定。
