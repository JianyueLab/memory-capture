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

describe('unreadable responses', () => {
  const base = { baseUrl: 'https://m.example.com', token: 'mem_t', body: {}, sleep: async () => {} };
  const rejects = async (promise, scope) => {
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ scope, code: 'bad_response' });
  };

  test('a 200 with a non-JSON body is a session failure', async () => {
    const { fetchImpl } = fakeFetch([new Response('<html>', { status: 200 })]);
    await rejects(postConversation({ ...base, fetchImpl }), 'session');
  });

  test('a 200 without conversation_id is a session failure', async () => {
    const { fetchImpl } = fakeFetch([json(200, { revision: 1 })]);
    await rejects(postConversation({ ...base, fetchImpl }), 'session');
  });

  test('a malformed project page stops the run', async () => {
    const { fetchImpl } = fakeFetch([json(200, { items: 'nope', next_cursor: null })]);
    await rejects(listProjects({ baseUrl: base.baseUrl, token: base.token, fetchImpl }), 'all');
  });
});
