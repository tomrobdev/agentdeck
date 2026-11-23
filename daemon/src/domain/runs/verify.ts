// The verify run: a claude run a person starts on a proposed or queued task, which reads the base in a scratch checkout and checks each claim the task's prompt makes about the code, answering with findings in VERIFY_ANSWER_SCHEMA.
import type { RunId } from '#domain/shared/index.ts';
import { plural } from '#domain/shared/index.ts';
import { CHECKED_STATUSES, type Task } from '#domain/work/index.ts';
import { REVIEW_DENIED_TOOLS, answerValue, isRecord } from '#domain/runs/review.ts';
import type { Run } from '#domain/runs/run.ts';

export const VERIFY_MAX_TURNS = 30;

export const VERIFY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git grep*)'];

export const VERIFY_DENIED_TOOLS = REVIEW_DENIED_TOOLS;

export const CLAIM_VERDICTS = ['true', 'false', 'stale', 'partly'] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

/** One claim the task's prompt makes about the code, and what the base says of it. */
export interface VerifyFinding {
  /** The claim, in the prompt's words or close to them. */
  claim: string;
  verdict: ClaimVerdict;
  /** The file that shows it, relative to the repo root; null when the run named none. */
  path: string | null;
  /** The line in `path`; null when the run named none. */
  line: number | null;
  /** The last line it covers, when that is more than `line`; null when it is one line. */
  end_line: number | null;
  /** What the code says, in a sentence or two. */
  evidence: string;
  /** For a claim that is not true, what the prompt should say instead; null when there is nothing to change. */
  fix: string | null;
}

/** A verify run's answer: its findings, none when the prompt makes no claim about the code. */
export interface VerifyAnswer {
  findings: VerifyFinding[];
}

export const VERIFY_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', minLength: 1, description: 'One claim the task’s prompt makes about the code' },
          verdict: {
            type: 'string',
            enum: [...CLAIM_VERDICTS],
            description:
              'true: the code bears it out; false: the code says otherwise; stale: it was true once, the code moved on; partly: part of it is true',
          },
          path: { type: 'string', description: 'The file that shows it, relative to the repo root' },
          line: { type: 'integer', minimum: 1, description: 'The line in that file' },
          end_line: { type: 'integer', minimum: 1, description: 'The last line, when the evidence covers more than one' },
          evidence: { type: 'string', minLength: 1, description: 'What the code says, in a sentence or two' },
          fix: { type: 'string', description: 'For a claim that is not true: what the prompt should say instead' },
        },
        required: ['claim', 'verdict', 'path', 'line', 'evidence'],
      },
    },
  },
  required: ['findings'],
};

export function verifySchemaArgs(): string[] {
  return ['--json-schema', JSON.stringify(VERIFY_ANSWER_SCHEMA)];
}

export function verifySystemPrompt(): string {
  return `You are running unattended as an AgentDeck verify run, inside a throwaway checkout of the repo's base branch.
- You check; you do not change anything. Never edit files, commit, push or switch branches.
- Some commands are refused by AgentDeck's tool rules. A refusal covers only that one command: try a simpler command or another tool.
- Answer in the JSON schema you were given: a finding for each claim the task's prompt makes about the code.`;
}

/** The base a verify run reads: the branch's name and the commit checked out. */
export interface VerifyContext {
  ref: string;
  commit: string;
}

export function buildVerifyPrompt(task: Pick<Task, 'id' | 'title' | 'prompt'>, ctx: VerifyContext): string {
  return [
    `AgentDeck verify run for task #${task.id}: "${task.title}".`,
    '',
    'This task has not started yet, and its prompt may have been written against an older state of the code. You are not its worker: check what the prompt says about the code against the code as it is now, before a person approves it.',
    '',
    "## The task's prompt",
    task.prompt.slice(0, 12000),
    '',
    '## The code',
    `You are in a checkout of ${ctx.ref} at ${ctx.commit}, the commit a worker would start from. \`git log\` and \`git show\` read its history.`,
    '',
    '## What to answer',
    '- A finding for each claim the prompt makes about the code: that a file, function, setting or test exists, where it is, what it does, what it is called.',
    '- Its verdict: true when the code bears it out, false when the code says otherwise, stale when it was true once but the code moved on (moved, renamed, already done), partly when only part of it is true.',
    '- The file and line that show it (and the last line, when it is a range), and the evidence in a sentence or two.',
    '- For a claim that is not true, a suggested fix: what the prompt should say instead.',
    '- Leave out what the prompt asks to be done and anything that is not about the code. No findings when it makes no claims.',
  ].join('\n');
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function wholeLine(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function parseFinding(v: unknown): VerifyFinding | null {
  if (!isRecord(v)) return null;
  const claim = text(v.claim);
  const verdict = text(v.verdict).toLowerCase() as ClaimVerdict;
  if (!claim || !CLAIM_VERDICTS.includes(verdict)) return null;
  const line = wholeLine(v.line);
  const end = wholeLine(v.end_line);
  return {
    claim,
    verdict,
    path: text(v.path) || null,
    line,
    end_line: line !== null && end !== null && end > line ? end : null,
    evidence: text(v.evidence),
    fix: text(v.fix) || null,
  };
}

export function parseVerifyAnswer(raw: unknown): VerifyAnswer | null {
  const v = answerValue(raw);
  if (!isRecord(v) || !Array.isArray(v.findings)) return null;
  return { findings: v.findings.map(parseFinding).filter((f): f is VerifyFinding => f !== null) };
}

export function verifyRefusal(task: Pick<Task, 'id' | 'status'>, runs: Pick<Run, 'kind' | 'ended_at'>[]): string | null {
  if (!CHECKED_STATUSES.includes(task.status)) return `#${task.id} is ${task.status}: a verify run is for a proposed or queued task`;
  if (runs.some((r) => r.kind === 'verify' && r.ended_at === null)) return `#${task.id} already has a verify run going`;
  return null;
}

/** The latest verify run of a task, as the dashboard and `agentdeck show` show it. */
export interface VerifyView {
  run_id: RunId;
  /** `going` while it runs; `done` with its findings; `failed` when it ended with none (failed, cancelled or garbage). */
  state: 'going' | 'done' | 'failed';
  /** The base commit it read; null until its checkout is made, or when it could not be. */
  commit: string | null;
  findings: VerifyFinding[];
  /** True once the base has moved on from the commit it read. */
  stale: boolean;
  /** Why it ended with no findings; null otherwise. */
  reason: string | null;
  started_at: string;
  ended_at: string | null;
}

export function runFindings(run: Pick<Run, 'kind' | 'outcome' | 'result_text'>): VerifyFinding[] | null {
  if (run.kind !== 'verify' || run.outcome !== 'done') return null;
  return parseVerifyAnswer(run.result_text)?.findings ?? null;
}

export function latestVerify(
  runs: (Pick<Run, 'id' | 'kind' | 'outcome' | 'result_text' | 'started_at' | 'ended_at'> & { base_commit?: string | null })[],
  base: string | null,
): VerifyView | null {
  const run = runs.findLast((r) => r.kind === 'verify');
  if (!run) return null;
  const findings = runFindings(run);
  const state = run.ended_at === null ? 'going' : findings ? 'done' : 'failed';
  const commit = run.base_commit ?? null;
  return {
    run_id: run.id,
    state,
    commit,
    findings: findings ?? [],
    stale: base !== null && commit !== null && commit !== base,
    reason: state === 'failed' ? (run.result_text ?? run.outcome ?? 'it ended with no findings') : null,
    started_at: run.started_at,
    ended_at: run.ended_at,
  };
}

export function verifyLine(findings: Pick<VerifyFinding, 'verdict'>[]): string {
  if (!findings.length) return 'No claims about the code';
  const counts = CLAIM_VERDICTS.flatMap((v) => {
    const n = findings.filter((f) => f.verdict === v).length;
    return n ? [`${n} ${v}`] : [];
  });
  return `${plural(findings.length, 'claim')}: ${counts.join(', ')}`;
}

export const findingPlace = (f: Pick<VerifyFinding, 'path' | 'line'> & { end_line?: number | null }): string | null =>
  f.path ? (f.line ? `${f.path}:${f.line}${f.end_line ? `-${f.end_line}` : ''}` : f.path) : null;

/** A verify run's findings to put on the task's issue, once. */
export interface VerifyIssueComment {
  run_id: RunId;
  comment: string;
}

function findingLines(f: VerifyFinding): string {
  const place = findingPlace(f);
  const head = `- **${f.verdict}**${place ? ` \`${place}\`` : ''}: ${f.claim}`;
  const evidence = `  ${f.evidence}`;
  return f.fix && f.verdict !== 'true' ? `${head}\n${evidence}\n  Suggested fix: ${f.fix}` : `${head}\n${evidence}`;
}

export function dueVerifyComment(
  task: Pick<Task, 'id'>,
  runs: Pick<Run, 'id' | 'kind' | 'outcome' | 'result_text' | 'ended_at' | 'base_commit'>[],
  reported: RunId | null,
): VerifyIssueComment | null {
  const run = runs.findLast((r) => r.kind === 'verify' && r.ended_at !== null);
  if (!run || run.id === reported) return null;
  const findings = runFindings(run);
  if (!findings?.length) return null;
  const read = run.base_commit ? ` read \`${run.base_commit.slice(0, 7)}\` and found` : ' found';
  return {
    run_id: run.id,
    comment: `A verify run on task #${task.id}${read} ${verifyLine(findings).toLowerCase()}.\n\n${findings.map(findingLines).join('\n')}`,
  };
}
