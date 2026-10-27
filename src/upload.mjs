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
      let result;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (typeof result?.conversation_id !== 'string' || result.conversation_id === '' || typeof result.revision !== 'number') {
        throw new UploadError('session', response.status, 'bad_response', 'server returned an unreadable response');
      }
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
    let page;
    try {
      page = await response.json();
    } catch {
      page = null;
    }
    if (!Array.isArray(page?.items) || (page.next_cursor !== null && typeof page.next_cursor !== 'string')) {
      throw new UploadError('all', response.status, 'bad_response', 'server returned an unreadable project list');
    }
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items.map((p) => ({ id: p.id, name: p.name, kind: p.kind, role: p.role, writable: p.role === 'owner' || p.role === 'editor' }));
}
