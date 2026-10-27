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
