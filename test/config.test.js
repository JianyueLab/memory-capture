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
