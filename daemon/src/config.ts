import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root for all runtime state: database, run logs, worktrees. */
export const HOME = process.env.AGENTDECK_HOME ?? join(homedir(), '.agentdeck');
export const DB_PATH = join(HOME, 'agentdeck.db');
export const LOG_DIR = join(HOME, 'logs');
export const WORKTREE_DIR = join(HOME, 'worktrees');

export function ensureDirs(): void {
  for (const dir of [HOME, LOG_DIR, WORKTREE_DIR]) mkdirSync(dir, { recursive: true });
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
