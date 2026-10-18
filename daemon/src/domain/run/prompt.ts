// What a worker's claude is told and allowed. Pure: no I/O.
import { ALWAYS_DISALLOWED_TOOLS } from '../repo/tools.ts';
import type { Task } from '../task/task.ts';
import type { Run } from './run.ts';

/** Appended to every worker's system prompt; the worker parses the STATUS line. */
export const WORKER_SYSTEM_PROMPT = `You are running unattended as an AgentDeck worker inside a git worktree on your own branch.
- Complete the task fully, keeping changes focused on it.
- Change files with the Edit and Write tools, not shell redirection or sed.
- Run the project's tests if there are any, and fix failures you caused.
- Commit your work with clear messages. Never push, never switch branches.
- If you cannot finish (missing info, needs a human decision, blocked by permissions), stop and explain why.
- End your final message with exactly one line: "STATUS: DONE" or "STATUS: BLOCKED: <one-line reason>".`;

export function buildPrompt(task: Task, previousRuns: Run[]): string {
  const last = previousRuns.at(-1);
  if (!last) return task.prompt;
  return [
    task.prompt,
    '',
    `--- This is attempt ${task.attempts}. The previous attempt ended as "${last.outcome}". ---`,
    last.tests_passed === 0 ? 'The test command failed after the previous attempt.' : '',
    last.result_text ? `Previous final message:\n${last.result_text.slice(0, 4000)}` : '',
    'Your earlier commits are already on this branch. Continue from there.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function claudeArgs(task: Task, allowed: string[], prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    task.model,
    '--max-turns',
    String(task.max_turns),
    '--permission-mode',
    'dontAsk',
    // One argv entry per rule: patterns like "Bash(npm test*)" contain spaces.
    '--allowedTools',
    ...allowed,
    '--disallowedTools',
    ...ALWAYS_DISALLOWED_TOOLS,
    '--append-system-prompt',
    WORKER_SYSTEM_PROMPT,
  ];
}
