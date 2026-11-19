// The plan review run: claude reads a plan branch's whole diff against its base, the plan's steps and their done criteria, and answers with a summary and findings as a review run does.
import { parsePlanWithText } from '#domain/work/index.ts';
import type { PlanBranch, Task } from '#domain/work/index.ts';
import { type ReviewAnswer, reviewDiffCommand, reviewVerdict } from '#domain/runs/review.ts';

/** What a plan review reads: the plan's page, the tasks that landed on the plan branch, and the commits its diff spans. */
export interface PlanReviewContext {
  /** The plan's name and page; null when the plan task has none. */
  plan: { name: string; html: string } | null;
  /** The tasks whose work is on the plan branch, with their status. */
  tasks: Pick<Task, 'id' | 'title' | 'status'>[];
  /** The commit the plan branch left its base at: the diff starts there. */
  from: string;
  /** The plan branch's head commit the review reads. */
  head: string;
}

export function planReviewSystemPrompt(): string {
  return `You are running unattended as an AgentDeck plan review run, inside a scratch checkout of a plan branch.
- You review; you do not change anything. Never edit files, commit, push or switch branches.
- Some commands are refused by AgentDeck's tool rules. A refusal covers only that one command: try a simpler command or another tool.
- Answer in the JSON schema you were given: a summary, and a finding for each problem, blocking only when the plan branch must not land as it is.`;
}

function allSteps(plan: PlanReviewContext['plan']): string {
  const parsed = plan && parsePlanWithText(plan.html);
  if (!plan) return 'The plan has no page attached.';
  if (!parsed) return `The plan ${plan.name} could not be read.`;
  const lines = [`The plan's steps (${plan.name}):`];
  parsed.plan.steps.forEach((step, i) => {
    lines.push('', `Step${step.id ? ` "${step.id}"` : ''}: ${step.title} (status: ${step.status})`);
    if (parsed.texts[i]) lines.push(parsed.texts[i].slice(0, 3000));
    if (step.done.length) lines.push('Done when:', ...step.done.map((d) => `- ${d}`));
  });
  return lines.join('\n');
}

export function buildPlanReviewPrompt(branch: Pick<PlanBranch, 'name' | 'base' | 'plan_task'>, ctx: PlanReviewContext): string {
  const tasks = ctx.tasks.map((t) => `- #${t.id} ${t.title} (${t.status})`);
  return [
    `AgentDeck plan review run for ${branch.name}, the plan branch of #${branch.plan_task}'s plan, before it lands on ${branch.base}.`,
    '',
    "Each task on this plan branch had its own review of its own slice. You read the whole: the plan branch's diff against its base, against the whole plan.",
    '',
    '## Plan',
    allSteps(ctx.plan),
    '',
    '## Tasks on the plan branch',
    ...(tasks.length ? tasks : ['- none']),
    '',
    '## The changes',
    `Run \`${reviewDiffCommand(ctx)}\` to see them (add \`--stat\` for the files), and \`git log ${ctx.from}..${ctx.head}\` for the commits.`,
    '',
    '## What to answer',
    "- A summary: whether the plan branch as a whole does what the plan's steps say and meets their done criteria.",
    "- A finding for each problem no task's own review could see: steps whose work contradicts another's, work missing between tasks, a done criterion nothing meets, code one task added that another broke.",
    '- Blocking only for what must not land on the base as it is. Style and small improvements are not blocking.',
    '- No findings when there is nothing to say.',
  ].join('\n');
}

export function planReviewComment(answer: ReviewAnswer): string {
  const verdict = reviewVerdict(answer) === 'clean' ? 'clean: no finding blocks' : 'blocking: this plan PR must not land as it is';
  const findings = answer.findings.map((f) => `- ${f.blocking ? '**Blocking** ' : ''}\`${f.path}:${f.line}\`: ${f.body}`);
  return [`**AgentDeck plan review**, ${verdict}.`, '', answer.summary, ...(findings.length ? ['', ...findings] : [])].join('\n');
}
