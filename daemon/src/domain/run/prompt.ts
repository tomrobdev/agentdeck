// What a worker's claude is told and allowed. Pure: no I/O.
import { PLAN_DIR, parsePlanWithText } from '../plan/plan.ts';
import { PR_SUMMARY_FORMAT } from '../pull-request/summary.ts';
import { ALWAYS_DISALLOWED_TOOLS } from '../repo/tools.ts';
import { withoutUnscopedFileTools } from './sandbox.ts';
import { type Task, leftoversMessage, planStepIds } from '../task/task.ts';
import { INTERRUPTED, type Run } from './run.ts';

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
    ? `- Before you finish, run \`${testCmd}\` and fix what fails, including formatting. AgentDeck runs it after you, and the task fails if it doesn't pass.
- Your shell commands run in a sandbox, and AgentDeck runs \`${testCmd}\` again outside it. A test that fails only because the sandbox refused something (EPERM, "operation not permitted", a refused host or port, a blocked \`ps\`) is not a reason to stop: fix every other failure, then finish with STATUS: DONE and name those tests in your final message.`
    : "- Run the project's tests if there are any, and fix failures you caused."
}
- Some commands are refused by AgentDeck's tool rules. A refusal covers only that one command: try a simpler command or another tool (Read, Glob, Grep instead of cat, find, grep), and keep working.
- Commit your work with clear messages. Never push, never switch branches.
- If the task asks for a plan, or is big enough to need one, write it to ${PLAN_DIR}<short-name>.html and commit it. AgentDeck reads it from these attributes:
  <html data-agentdeck-plan="1">, a <title>, one <p data-plan-summary> saying what and why,
  and one <section data-plan-step id="…" data-status="todo|doing|done|blocked|skipped"> per step, its <h2> the step's title.
  A step may list its checks in <ul data-plan-done>, one <li> each.
  Everything else is free HTML. Keep each step's data-status current as you work.
- If you can't finish because the environment lacks something, say exactly what on the STATUS line instead of working around it: "STATUS: BLOCKED: NEEDS deps: <packages>", "NEEDS host: <hosts>" or "NEEDS edit: <files>" (a file you may not edit, such as one under .claude/). Never install packages yourself.
- If you cannot finish (missing info, needs a human decision, blocked by permissions), stop and explain why.
- When you finish with STATUS: DONE, your final message is the pull request body. Write it as ${PR_SUMMARY_FORMAT}
  Then the STATUS line. A STATUS: BLOCKED message is free-form.
- End your final message with exactly one line: "STATUS: DONE" or "STATUS: BLOCKED: <one-line reason>".`;
}

/** The plan a run follows: its repo-relative path and its HTML from the task's branch, null when the file is missing. */
export interface PromptPlan {
  path: string;
  html: string | null;
}

/**
 * The block after the task's prompt that carries the plan's steps: the linked steps (`task.plan_steps`, or every step
 * when none are named) that are not yet done or skipped, with their text and done criteria.
 */
export function planPromptBlock(task: Pick<Task, 'plan_steps'>, plan: PromptPlan): string {
  const parsed = plan.html === null ? null : parsePlanWithText(plan.html);
  if (!parsed) {
    return `The plan ${plan.path} is not on this branch (or is not a readable plan). Work from the task above.`;
  }
  const ids = planStepIds(task);
  const lines = [`--- Plan: ${plan.path} ---`, parsed.plan.title];
  if (parsed.plan.summary) lines.push(parsed.plan.summary);
  const steps = parsed.plan.steps
    .map((step, i) => ({ step, text: parsed.texts[i] }))
    .filter(
      ({ step }) => (ids === null || (step.id !== null && ids.includes(step.id))) && step.status !== 'done' && step.status !== 'skipped',
    );
  if (!steps.length) {
    lines.push('', 'Every step you were given is already done or skipped. Check the work, and finish with STATUS: DONE.');
    return lines.join('\n');
  }
  for (const { step, text } of steps) {
    lines.push('', `Step${step.id ? ` "${step.id}"` : ''}: ${step.title} (status: ${step.status})`);
    if (text) lines.push(text);
    if (step.done.length) lines.push('Done when:', ...step.done.map((d) => `- ${d}`));
  }
  lines.push(
    '',
    `Do only these steps. Set each one's data-status in ${plan.path} as you go, and commit the plan with the work. Mark a step you can't do blocked and say why inside the step.`,
  );
  return lines.join('\n');
}

/**
 * `reviewNote` is what the person asked to change when they sent the task back from review. `plan` is the plan the task
 * carries out, if any: its steps go after the task's prompt.
 */
export function buildPrompt(task: Task, previousRuns: Run[], reviewNote: string | null = null, plan: PromptPlan | null = null): string {
  const last = previousRuns.filter((r) => r.kind !== 'resolve').at(-1);
  const base = plan ? `${task.prompt}\n\n${planPromptBlock(task, plan)}` : task.prompt;
  if (!last) return base;
  // A restart's run was cut off, not finished: it has no verdict or final message to pass on.
  const interrupted = last.outcome === INTERRUPTED;
  return [
    reviewNote ? `Changes requested in review:\n${reviewNote}\n` : '',
    base,
    '',
    interrupted
      ? `--- This is attempt ${task.attempts}. A daemon restart stopped an earlier run of it before it finished. ---`
      : `--- This is attempt ${task.attempts}. The previous attempt ended as "${last.outcome}". ---`,
    last.tests_passed === 0 ? 'The test command failed after the previous attempt.' : '',
    last.result_text && !interrupted ? `Previous final message:\n${last.result_text.slice(0, 4000)}` : '',
    'Your earlier commits are already on this branch. Continue from there.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The prompt of a run that resumes the claude session a daemon restart cut off (`resumableSession`). The session
 * already holds the task and its plan; this says what happened and that the worktree may have moved on since: the
 * sync before every run commits what was left uncommitted and may merge the base branch in.
 */
export function buildResumePrompt(task: Pick<Task, 'id' | 'title'>): string {
  const leftovers = leftoversMessage(task).split('\n')[0];
  return [
    'AgentDeck restarted while you were working on this task, which stopped you mid-run. This is the same task and the same attempt: carry on from where you stopped.',
    '',
    'First check the state of the worktree, since it may differ from what you remember:',
    '- `git status` and `git diff` for uncommitted changes.',
    `- \`git log\`: before resuming you, AgentDeck commits whatever was left uncommitted as "${leftovers}", and may have merged the base branch in.`,
    'Then finish the task as instructed before, and end with the STATUS line.',
  ].join('\n');
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

/**
 * `settings` is the run's settings file (sandbox and worktree-only file rules, domain/run/sandbox.ts). `resume` is a
 * claude session to continue (`resumableSession`); everything else, the system prompt and tool rules included, is
 * the same as for a fresh run.
 */
export function claudeArgs(
  task: Task,
  allowed: string[],
  prompt: string,
  testCmd: string | null,
  settings: string,
  resume: string | null = null,
): string[] {
  return [
    '--settings',
    settings,
    '-p',
    prompt,
    ...(resume ? ['--resume', resume] : []),
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
