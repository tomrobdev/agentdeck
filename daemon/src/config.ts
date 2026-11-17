import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const HOME = resolve(process.env.AGENTDECK_HOME ?? join(homedir(), '.agentdeck'));
export const CHECKOUT_ROOT = resolve(import.meta.dirname, '../..');
export const DB_PATH = join(HOME, 'agentdeck.db');
export const LOG_DIR = join(HOME, 'logs');
export const WORKTREE_DIR = join(HOME, 'worktrees');
export const GOALS_DIR = join(HOME, 'goals');

export const API_PORT = Number(process.env.AGENTDECK_PORT ?? 4317);

export const API_ALLOWED_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  ...(process.env.AGENTDECK_ORIGINS ?? '').split(',').filter(Boolean),
]);

export const API_TOKEN_PATH = join(HOME, 'api-token');

export function apiToken(path = API_TOKEN_PATH, env = process.env.AGENTDECK_API_TOKEN): string {
  if (env) return env;
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');
  const found = read();
  if (found) return found;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return read();
}

export const bearer = (token: string): string => `Bearer ${token}`;

export function ensureDirs(): void {
  for (const dir of [HOME, LOG_DIR, WORKTREE_DIR, GOALS_DIR]) mkdirSync(dir, { recursive: true });
}

export function claudeBin(): string {
  if (process.env.AGENTDECK_CLAUDE_BIN) return process.env.AGENTDECK_CLAUDE_BIN;
  for (const p of [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

export const RUST_DIRS = [join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin'];

export function rustDirs(exists: (path: string) => boolean = existsSync): string[] {
  return RUST_DIRS.filter((dir) => exists(dir));
}

export function withToolchainPath(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): Record<string, string | undefined> {
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of rustDirs(exists)) if (!dirs.includes(dir)) dirs.push(dir);
  return { ...env, PATH: dirs.join(':') };
}

export const DEFAULTS = {
  maxConcurrent: 2,
  maxTurns: 40,
  maxAttempts: 2,
  tickMs: 5_000,
};

export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const TEST_TIMEOUT_MS = 15 * 60_000;
