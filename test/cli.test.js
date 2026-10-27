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

  test('an unreadable upload response fails only that session', async () => {
    const inner = server();
    const fetchImpl = async (url, init) => {
      if (init?.method === 'POST' && JSON.parse(init.body).source_conversation_id === 'c-1') return new Response('not json', { status: 201 });
      return inner.fetchImpl(url, init);
    };
    expect(await run(['send', 'claude-code:c-1', 'omp:o-1', '--project', 'p-personal', '--json'], deps({ env: { JYL_MEMORY_TOKEN: TOKEN }, fetch: fetchImpl }))).toBe(1);
    expect(lastJson()).toEqual([
      expect.objectContaining({ key: 'claude-code:c-1', status: 'failed', code: 'bad_response', uploaded: 0 }),
      expect.objectContaining({ key: 'omp:o-1', status: 'sent', uploaded: 2 }),
    ]);
  });

  test('send reports a conversation the server replaced with a new id', async () => {
    const inner = server();
    let calls = 0;
    const fetchImpl = async (url, init) => {
      const response = await inner.fetchImpl(url, init);
      if (init?.method !== 'POST') return response;
      calls += 1;
      return calls === 1 ? response : json(201, { conversation_id: `conv-new-${calls}`, revision: 1, job_ids: [] });
    };
    const env = { JYL_MEMORY_TOKEN: TOKEN };
    const file = join(home, '.claude/projects/-work-alpha/c-1.jsonl');
    const user = (uuid, s) => ({ type: 'user', sessionId: 'c-1', uuid, timestamp: `2026-10-27T01:01:0${s}.000Z`, message: { role: 'user', content: `More ${s}` } });
    expect(await run(['send', 'claude-code:c-1', '--project', 'p-personal', '--json'], deps({ env, fetch: fetchImpl }))).toBe(0);
    expect(lastJson()[0]).not.toHaveProperty('replaced_conversation_id');

    writeJsonl(file, [...claudeSession('c-1'), user('u8', 1)], new Date(NOW - 60_000));
    stdout = sink();
    expect(await run(['send', 'claude-code:c-1', '--project', 'p-personal', '--json'], deps({ env, fetch: fetchImpl }))).toBe(0);
    expect(lastJson()[0]).toMatchObject({ status: 'sent', conversation_id: 'conv-new-2', replaced_conversation_id: 'conv-c-1', uploaded: 1 });

    writeJsonl(file, [...claudeSession('c-1'), user('u8', 1), user('u9', 2)], new Date(NOW - 30_000));
    stdout = sink();
    expect(await run(['send', 'claude-code:c-1', '--project', 'p-personal'], deps({ env, fetch: fetchImpl }))).toBe(0);
    expect(stdout.text()).toContain('(replaces conversation conv-new-2)');
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
