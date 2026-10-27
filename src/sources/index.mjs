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
