import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for all runtime state: database, run logs, worktrees. */
export const HOME = process.env.AGENTDECK_HOME ?? join(homedir(), '.agentdeck');
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

/** Tools a worker may use unless the repo overrides them. No push, no network installs. */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(ls*)',
  'Bash(cat*)',
  'Bash(node *)',
  'Bash(npm test*)',
  'Bash(npm run *)',
];

export const ALWAYS_DISALLOWED_TOOLS = ['Bash(git push*)', 'Bash(git remote*)', 'Bash(rm -rf*)'];

/** Appended to every worker's system prompt; the worker parses the STATUS line. */
export const WORKER_SYSTEM_PROMPT = `You are running unattended as an AgentDeck worker inside a git worktree on your own branch.
- Complete the task fully, keeping changes focused on it.
- Change files with the Edit and Write tools, not shell redirection or sed.
- Run the project's tests if there are any, and fix failures you caused.
- Commit your work with clear messages. Never push, never switch branches.
- If you cannot finish (missing info, needs a human decision, blocked by permissions), stop and explain why.
- End your final message with exactly one line: "STATUS: DONE" or "STATUS: BLOCKED: <one-line reason>".`;

export const DEFAULTS = {
  maxConcurrent: 2,
  maxTurns: 40,
  maxAttempts: 2,
  model: 'sonnet',
  tickMs: 5_000,
};
