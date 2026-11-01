import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Root for all runtime state: database, run logs, worktrees. */
// Resolved, so a relative AGENTDECK_HOME doesn't change meaning when git or a worktree runs elsewhere.
export const HOME = resolve(process.env.AGENTDECK_HOME ?? join(homedir(), '.agentdeck'));
/** The checkout this code runs from (this file is daemon/src/config.ts). */
export const CHECKOUT_ROOT = resolve(import.meta.dirname, '../..');
export const DB_PATH = join(HOME, 'agentdeck.db');
export const LOG_DIR = join(HOME, 'logs');
export const WORKTREE_DIR = join(HOME, 'worktrees');
/** One goals file per repo, `<repo name>.md`, read by the planner. */
export const GOALS_DIR = join(HOME, 'goals');

/** Local API for the dashboard. Bound to 127.0.0.1 only. */
export const API_PORT = Number(process.env.AGENTDECK_PORT ?? 4317);

/** Origins allowed to call the API from a browser context: the Tauri webview and the Vite dev server. */
export const API_ALLOWED_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
]);

export function ensureDirs(): void {
  for (const dir of [HOME, LOG_DIR, WORKTREE_DIR, GOALS_DIR]) mkdirSync(dir, { recursive: true });
}

/** launchd starts us with a bare PATH, so look in the usual install spots. */
export function claudeBin(): string {
  if (process.env.AGENTDECK_CLAUDE_BIN) return process.env.AGENTDECK_CLAUDE_BIN;
  for (const p of [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

export const DEFAULTS = {
  maxConcurrent: 2,
  maxTurns: 40,
  maxAttempts: 2,
  model: 'sonnet',
  tickMs: 5_000,
};

/** How long a repo's setup and test commands may run. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const TEST_TIMEOUT_MS = 15 * 60_000;
