// What a worker's claude is told and allowed. Pure: no I/O.
import { PLAN_DIR } from '../plan/plan.ts';
import { ALWAYS_DISALLOWED_TOOLS } from '../repo/tools.ts';
import { withoutUnscopedFileTools } from './sandbox.ts';
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
  const last = previousRuns.filter((r) => r.kind !== 'resolve').at(-1);
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

/** How many commit messages of each side the resolve prompt quotes. */
const SIDE_COMMITS = 15;

export interface ResolveContext {
  /** The base branch being merged into the task's branch, as the person knows it ("main"). */
  base: string;
  /** Files with conflict markers. */
  files: string[];
  /** Subjects of the commits on the task's branch that the base does not have. */
  ours: string[];
  /** Subjects of the commits on the base that the task's branch does not have. */
  theirs: string[];
  testCmd: string | null;
}

const bullets = (subjects: string[]) =>
  subjects.length
    ? [
        ...subjects.slice(0, SIDE_COMMITS).map((s) => `- ${s}`),
        ...(subjects.length > SIDE_COMMITS ? [`- … and ${subjects.length - SIDE_COMMITS} more`] : []),
      ].join('\n')
    : '- (none)';

/**
 * The prompt of a resolve run: the merge of the base into the task's branch is under way in the worktree and has
 * conflicts. It names the files, both sides' commit messages and the task's goal, and asks for the intent of both sides.
 */
export function buildResolvePrompt(task: Pick<Task, 'id' | 'title' | 'prompt'>, ctx: ResolveContext): string {
  return [
    `AgentDeck conflict resolution for task #${task.id}: "${task.title}".`,
    '',
    `AgentDeck is merging \`${ctx.base}\` into this task's branch, and the merge stopped on conflicts. It is still in progress in this worktree: the conflicting files hold conflict markers (<<<<<<<, =======, >>>>>>>).`,
    '',
    'Conflicting files:',
    ...ctx.files.map((f) => `- ${f}`),
    '',
    "The task's goal (what this branch is for):",
    task.prompt.slice(0, 4000),
    '',
    `Commits on this branch (the task's side):`,
    bullets(ctx.ours),
    '',
    `Commits on ${ctx.base} (the other side):`,
    bullets(ctx.theirs),
    '',
    "Resolve every conflict so that the result keeps the intent of both sides: do not drop either side's change just to make the markers go away, and do not add unrelated changes.",
    ctx.testCmd
      ? `When no markers are left, run \`${ctx.testCmd}\` and fix what fails.`
      : 'When no markers are left, run the tests if the project has any.',
    'Then stage the files with `git add` and conclude the merge with `git commit --no-edit`. Do not abort the merge, switch branches or push.',
    'If you cannot resolve it with confidence, stop and end with STATUS: BLOCKED and the reason.',
  ].join('\n');
}

/** `settings` is the run's settings file (sandbox and worktree-only file rules, domain/run/sandbox.ts). */
export function claudeArgs(task: Task, allowed: string[], prompt: string, testCmd: string | null, settings: string): string[] {
  return [
    '--settings',
    settings,
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
    // Edit and Write come from the settings file, limited to the worktree.
    ...withoutUnscopedFileTools(allowed),
    // Kept on top of the sandbox: the agent never pushes, sandbox or not.
    '--disallowedTools',
    ...ALWAYS_DISALLOWED_TOOLS,
    '--append-system-prompt',
    workerSystemPrompt(testCmd),
  ];
}
