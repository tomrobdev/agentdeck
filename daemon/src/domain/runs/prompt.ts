// What a worker's claude is told and allowed.
import { PLAN_FILE, parsePlanWithText } from '../work/index.ts';
import { PR_SUMMARY_FORMAT } from '../landing/index.ts';
import { ALWAYS_DISALLOWED_TOOLS } from '../repos/index.ts';
import { type ReviewPrompt, reviewPromptBlock } from '../landing/index.ts';
import { NEVER_APPLIED, PROTECTED_PREFIXES, editPathFor } from '../repos/index.ts';
import { withoutUnscopedFileTools } from './translate/sandbox.ts';
import { type Task, leftoversMessage } from '../work/index.ts';
import { INTERRUPTED, type Run } from './run.ts';
import { UNBLOCK_NOTE } from './unblock.ts';
import { REVIEW_NOTE } from './review.ts';

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
- If the task asks for a plan, or is big enough to need one, and the prompt gives you none, write it to ${PLAN_FILE}. AgentDeck keeps it as the task's plan after the run; git ignores that file, so never commit it or copy it elsewhere in the repo. AgentDeck reads it from these attributes:
  <html data-agentdeck-plan="1">, a <title>, one <p data-plan-summary> saying what and why,
  and one <section data-plan-step id="…" data-status="todo|doing|done|blocked|skipped"> per step, its <h2> the step's title.
  Every step needs an id of its own: AgentDeck saves steps back by id, and a step without one can be lost.
  A step may list its checks in <ul data-plan-done>, one <li> each.
  Put <link rel="stylesheet" href="plan.css" /> in the <head> and add no <style> block: AgentDeck styles every plan.
  Everything else is free HTML. Keep each step's data-status current as you work.
- You may not edit files under ${PROTECTED_PREFIXES.join(', ')}. When the task needs one changed, write the whole new file to ${editPathFor('.claude/<path>')} instead (say ${editPathFor('.claude/skills/x/SKILL.md')} for .claude/skills/x/SKILL.md: leave the dot off, since a path with a .claude folder in it is refused anywhere), name it in your final message, and carry on. AgentDeck commits it to your branch after the run, and a person reviews it before it merges. It never applies ${NEVER_APPLIED.join(', ')}: for those, block with NEEDS edit.
- If you can't finish because the environment lacks something, say exactly what on the STATUS line instead of working around it: "STATUS: BLOCKED: NEEDS deps: <packages>", "NEEDS host: <hosts>" or "NEEDS edit: <files>" (a settings or hooks file above). Never install packages yourself.
- If you cannot finish (missing info, needs a human decision, blocked by permissions), stop and explain why.
- When you finish with STATUS: DONE, your final message is the pull request body. Write it as ${PR_SUMMARY_FORMAT}
  If the prompt lists review comments (c1, c2…), add one line per comment after the pull request body: "ANSWER c1: <what you did, or why not>". Each answer is a single line. AgentDeck shows it on the comment.
  Then the STATUS line. A STATUS: BLOCKED message is free-form.
- End your final message with exactly one line: "STATUS: DONE" or "STATUS: BLOCKED: <one-line reason>".`;
}

/**
 * The plan a run follows: its name (`112-plans-in-agentdeck.html`) and its HTML as AgentDeck stores it, null when it
 * is gone. `steps` are the step ids the task is linked to, null for every step.
 */
export interface PromptPlan {
  name: string;
  html: string | null;
  steps: string[] | null;
}

export function planPromptBlock(plan: PromptPlan): string {
  const parsed = plan.html === null ? null : parsePlanWithText(plan.html);
  if (!parsed) {
    return `The plan ${plan.name} could not be read. Work from the task above.`;
  }
  const ids = plan.steps;
  const lines = [`--- Plan: ${plan.name} (in ${PLAN_FILE}) ---`, parsed.plan.title];
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
    `Do only these steps. Set each one's data-status in ${PLAN_FILE} as you go, and never commit that file: AgentDeck keeps the plan, and saves only these steps' sections from it after the run, matched by id, so keep each step's id. Mark a step you can't do blocked and say why inside the step.`,
  );
  return lines.join('\n');
}

export function buildPrompt(
  task: Task,
  previousRuns: Run[],
  reviewNote: string | null = null,
  plan: PromptPlan | null = null,
  review: ReviewPrompt | null = null,
  escalated: string | null = null,
): string {
  const work = previousRuns.filter((r) => r.kind === 'work');
  const last = work.at(-1);
  const base = plan ? `${task.prompt}\n\n${planPromptBlock(plan)}` : task.prompt;
  if (!last) return base;
  const interrupted = last.outcome === INTERRUPTED;
  const finished = work.findLast((r) => r.outcome !== INTERRUPTED);
  const verdict = !finished
    ? ''
    : !interrupted
      ? `--- This is attempt ${task.attempts}. The previous attempt ended as "${finished.outcome}". ---`
      : finished.attempt < task.attempts
        ? `Before that, the previous attempt ended as "${finished.outcome}".`
        : `Before that, a run of this attempt ended as "${finished.outcome}".`;
  const named = reviewNote !== null && (reviewNote.startsWith(UNBLOCK_NOTE) || reviewNote.startsWith(REVIEW_NOTE));
  const note = reviewNote === null ? '' : named ? `${reviewNote}\n` : `Changes requested in review:\n${reviewNote}\n`;
  return [
    review ? `${reviewPromptBlock(review)}\n` : '',
    review?.ownRetry ? '' : note,
    base,
    '',
    interrupted ? `--- This is attempt ${task.attempts}. A daemon restart stopped an earlier run of it before it finished. ---` : '',
    verdict,
    escalated ? `This attempt ${escalated}.` : '',
    finished?.tests_passed === false ? 'The test command failed after the previous attempt.' : '',
    finished?.result_text ? `Previous final message:\n${finished.result_text.slice(0, 4000)}` : '',
    'Your earlier commits are already on this branch. Continue from there.',
  ]
    .filter(Boolean)
    .join('\n');
}

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

export function claudeArgs(
  run: { model: string; max_turns: number },
  allowed: string[],
  prompt: string,
  testCmd: string | null,
  settings: string,
  resume: string | null = null,
  maxTurns: number = run.max_turns,
  systemPrompt: string = workerSystemPrompt(testCmd),
  extra: { disallowed?: string[]; args?: string[] } = {},
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
    run.model,
    '--max-turns',
    String(maxTurns),
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--allowedTools',
    ...withoutUnscopedFileTools(allowed),
    '--disallowedTools',
    ...ALWAYS_DISALLOWED_TOOLS,
    ...(extra.disallowed ?? []),
    '--append-system-prompt',
    systemPrompt,
    ...(extra.args ?? []),
  ];
}
