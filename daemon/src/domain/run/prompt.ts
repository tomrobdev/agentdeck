// What a worker's claude is told and allowed. Pure: no I/O.
import { PLAN_DIR } from '../plan/plan.ts';
import { ALWAYS_DISALLOWED_TOOLS } from '../repo/tools.ts';
import type { Task } from '../task/task.ts';
import type { Run } from './run.ts';

/**
 * Appended to every worker's system prompt; the worker parses the STATUS line. `testCmd` is the command
 * AgentDeck runs after the agent finishes: naming it lets the agent pass it first.
 */
export function workerSystemPrompt(testCmd: string | null): string {
  return `You are running unattended as an AgentDeck worker inside a git worktree on your own branch.
- Complete the task fully, keeping changes focused on it.
- Change files with the Edit and Write tools, not shell redirection or sed.
${
  testCmd
    ? `- Before you finish, run \`${testCmd}\` and fix what fails, including formatting. AgentDeck runs it after you, and the task fails if it doesn't pass.`
    : "- Run the project's tests if there are any, and fix failures you caused."
}
- Some commands are refused by AgentDeck's tool rules. A refusal covers only that one command: try a simpler command or another tool (Read, Glob, Grep instead of cat, find, grep), and keep working.
- Commit your work with clear messages. Never push, never switch branches.
- If the task asks for a plan, or is big enough to need one, write it to ${PLAN_DIR}<short-name>.html and commit it. AgentDeck reads it from these attributes:
  <html data-agentdeck-plan="1">, a <title>, one <p data-plan-summary> saying what and why,
  and one <section data-plan-step id="…" data-status="todo|doing|done|blocked|skipped"> per step, its <h2> the step's title.
  Everything else is free HTML. Keep each step's data-status current as you work.
- If you cannot finish (missing info, needs a human decision, blocked by permissions), stop and explain why.
- End your final message with exactly one line: "STATUS: DONE" or "STATUS: BLOCKED: <one-line reason>".`;
}

/** `reviewNote` is what the person asked to change when they sent the task back from review. */
export function buildPrompt(task: Task, previousRuns: Run[], reviewNote: string | null = null): string {
  const last = previousRuns.at(-1);
  if (!last) return task.prompt;
  return [
    reviewNote ? `Changes requested in review:\n${reviewNote}\n` : '',
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

export function claudeArgs(task: Task, allowed: string[], prompt: string, testCmd: string | null): string[] {
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
    workerSystemPrompt(testCmd),
  ];
}
