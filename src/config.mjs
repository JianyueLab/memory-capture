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
