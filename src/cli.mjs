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
      const previousId = state.sessions[key]?.conversation_id ?? null;
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
        const result = { key, status: 'sent', conversation_id: done.conversationId, url: `${config.baseUrl}/conversations/${done.conversationId}`, uploaded };
        if (previousId && previousId !== done.conversationId) result.replaced_conversation_id = previousId;
        results.push(result);
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
      if (r.status === 'sent') {
        const replaced = r.replaced_conversation_id ? `  (replaces conversation ${r.replaced_conversation_id})` : '';
        out(`sent         ${r.key}  ${r.uploaded} messages  ${r.url}${replaced}`);
      } else if (r.status === 'nothing_new') out(`nothing new  ${r.key}`);
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
