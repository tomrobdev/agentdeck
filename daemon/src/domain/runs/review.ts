// The review run: a claude run that reads a done task's changes against its Goal, Definition of done and linked plan steps, and answers with a summary and findings in REVIEW_ANSWER_SCHEMA.
import {
  BLOCKING_PREFIX,
  COMMENT_SIDES,
  type CommentSide,
  type ReviewKind,
  countedReviewRuns,
  reviewReason,
} from '#domain/landing/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { parsePlanWithText } from '#domain/work/index.ts';
import type { Task, TaskEventRow } from '#domain/work/index.ts';
import type { PromptPlan } from '#domain/runs/prompt.ts';
import type { Run } from '#domain/runs/run.ts';

export const REVIEW_NOTE = 'Review run: ';

export const REVIEW_MAX_TURNS = 30;

export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)'];

export const REVIEW_DENIED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

export function reviewable(
  task: Pick<Task, 'status' | 'pr'>,
  runs: Pick<Run, 'kind' | 'diff_hash' | 'outcome'>[],
  repo: Pick<Repo, 'auto_review'>,
  diffHash: string | null,
): boolean {
  if (!repo.auto_review || task.status !== 'done' || task.pr?.state !== 'open' || !diffHash) return false;
  return countedReviewRuns(runs, diffHash).length === 0;
}

/** What follows a review run's answer: the review it stores, and the note to retry the task with, null for none. */
export interface ReviewOutcome {
  record: ReviewRecord;
  retry: string | null;
}

export function reviewOutcome(answer: ReviewAnswer, events: Pick<TaskEventRow, 'type'>[]): ReviewOutcome {
  const record = reviewRecord(answer);
  const retried = events.some((e) => e.type === 'review_retry');
  const retry = record.kind === 'request_changes' && !retried ? `${REVIEW_NOTE}${reviewReason(record.body, record.comments)}` : null;
  return { record, retry };
}

/** One thing a review run found: where it is in the diff, what it says, and whether it stops the task merging. */
export interface ReviewFinding {
  path: string;
  /** The line it points at, counted on `side`. */
  line: number;
  /** The base file (old) or the task's head (new), as a person's comment. */
  side: CommentSide;
  body: string;
  /** True when the task must not merge until it is handled. */
  blocking: boolean;
}

/** A review run's answer: a summary of the changes, and its findings. */
export interface ReviewAnswer {
  summary: string;
  findings: ReviewFinding[];
}

/** Whether a review run's answer lets the task go on: clean when no finding blocks. */
export type ReviewVerdict = 'clean' | 'blocking';

export const REVIEW_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      description: 'What the changes do and whether they meet the goal and the definition of done, in a few sentences',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file, relative to the repo root' },
          line: { type: 'integer', minimum: 1, description: 'The line the finding points at, counted on its side' },
          side: {
            type: 'string',
            enum: [...COMMENT_SIDES],
            description: 'new: a line of the task’s head; old: a removed line of the base',
          },
          body: { type: 'string', minLength: 1, description: 'What is wrong and what to do about it' },
          blocking: { type: 'boolean', description: 'True when the task must not merge until this is handled' },
        },
        required: ['path', 'line', 'side', 'body', 'blocking'],
      },
    },
  },
  required: ['summary', 'findings'],
};

export function reviewSchemaArgs(): string[] {
  return ['--json-schema', JSON.stringify(REVIEW_ANSWER_SCHEMA)];
}

export function reviewSystemPrompt(): string {
  return `You are running unattended as an AgentDeck review run, inside a done task's git worktree on its branch.
- You review; you do not change anything. Never edit files, commit, push or switch branches.
- Some commands are refused by AgentDeck's tool rules. A refusal covers only that one command: try a simpler command or another tool.
- Answer in the JSON schema you were given: a summary, and a finding for each problem, blocking only when the task must not merge as it is.`;
}

export function promptSection(prompt: string, heading: string): string | null {
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  return body || null;
}

function planSteps(plan: PromptPlan): string {
  const parsed = plan.html === null ? null : parsePlanWithText(plan.html);
  if (!parsed) return `The task follows the plan ${plan.name}, which could not be read.`;
  const ids = plan.steps;
  const lines = [`The task's plan steps (${plan.name}):`];
  parsed.plan.steps.forEach((step, i) => {
    if (ids !== null && (step.id === null || !ids.includes(step.id))) return;
    lines.push('', `Step${step.id ? ` "${step.id}"` : ''}: ${step.title} (status: ${step.status})`);
    if (parsed.texts[i]) lines.push(parsed.texts[i].slice(0, 3000));
    if (step.done.length) lines.push('Done when:', ...step.done.map((d) => `- ${d}`));
  });
  return lines.join('\n');
}

export interface ReviewContext {
  /** The plan the task follows, if any. */
  plan: PromptPlan | null;
  /** The commit the task's branch left the base at (`diffBase`): the diff starts there. */
  from: string;
  /** The task's head commit the review reads. */
  head: string;
}

export const reviewDiffCommand = (ctx: Pick<ReviewContext, 'from' | 'head'>): string => `git diff ${ctx.from} ${ctx.head}`;

export function buildReviewPrompt(task: Pick<Task, 'id' | 'title' | 'prompt'>, ctx: ReviewContext): string {
  const goal = promptSection(task.prompt, 'Goal');
  const done = promptSection(task.prompt, 'Definition of done');
  return [
    `AgentDeck review run for task #${task.id}: "${task.title}".`,
    '',
    "This task's worker finished and reported it done. You are not that worker: read its changes and judge whether they do what the task asks, before they merge.",
    '',
    '## Goal',
    (goal ?? task.prompt).slice(0, 4000),
    ...(done ? ['', '## Definition of done', done.slice(0, 4000)] : []),
    ...(ctx.plan ? ['', '## Plan steps', planSteps(ctx.plan)] : []),
    '',
    '## The changes',
    `Run \`${reviewDiffCommand(ctx)}\` to see them (add \`--stat\` for the files), and read the files around them where you need to.`,
    '',
    '## What to answer',
    '- A summary: what the changes do, and whether they meet the goal, the definition of done and the plan steps.',
    '- A finding for each problem: the file, the line (on the new side for a line of the head, the old side for a removed one), what is wrong and what to do.',
    '- Blocking only for what must not merge as it is: a bug, a missed requirement or done criterion, a broken test, a security hole. Style and small improvements are not blocking.',
    '- No findings when there is nothing to say.',
  ].join('\n');
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function answerValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(raw);
  const text = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseFinding(v: unknown): ReviewFinding | null {
  if (!isRecord(v)) return null;
  const path = typeof v.path === 'string' ? v.path.trim() : '';
  const body = typeof v.body === 'string' ? v.body.trim() : '';
  const line = typeof v.line === 'string' ? Number(v.line) : v.line;
  if (!path || !body || typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
  const side: CommentSide = v.side === 'old' ? 'old' : 'new';
  return { path, line, side, body, blocking: v.blocking !== false };
}

export function parseReviewAnswer(raw: unknown): ReviewAnswer | null {
  const v = answerValue(raw);
  if (!isRecord(v)) return null;
  const summary = typeof v.summary === 'string' ? v.summary.trim() : '';
  if (!summary) return null;
  const findings = Array.isArray(v.findings) ? v.findings.map(parseFinding).filter((f): f is ReviewFinding => f !== null) : [];
  return { summary, findings };
}

export function reviewVerdict(answer: Pick<ReviewAnswer, 'findings'>): ReviewVerdict {
  return answer.findings.some((f) => f.blocking) ? 'blocking' : 'clean';
}

/** A review run's review, as it is stored: its kind, its note and its line comments. */
export interface ReviewRecord {
  kind: ReviewKind;
  body: string;
  comments: Pick<ReviewFinding, 'path' | 'line' | 'side' | 'body'>[];
}

export function reviewRecord(answer: ReviewAnswer): ReviewRecord {
  return {
    kind: reviewVerdict(answer) === 'clean' ? 'comment' : 'request_changes',
    body: answer.summary,
    comments: answer.findings.map((f) => ({
      path: f.path,
      line: f.line,
      side: f.side,
      body: f.blocking ? `${BLOCKING_PREFIX}${f.body}` : f.body,
    })),
  };
}
