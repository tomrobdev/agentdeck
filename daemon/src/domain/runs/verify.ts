// The verify run: a claude run a person starts on a proposed or queued task, which reads the base in a scratch checkout and
// checks each claim the task's prompt makes about the code, answering with findings in VERIFY_ANSWER_SCHEMA. It uses no
// attempt, takes the review model and changes nothing: what to do about its findings is a person's call. Pure: no I/O.
import type { RunId } from '../shared/index.ts';
import { plural } from '../shared/index.ts';
import { CHECKED_STATUSES, type Task } from '../work/index.ts';
import { REVIEW_DENIED_TOOLS, answerValue, isRecord } from './review.ts';
import type { Run } from './run.ts';

/** A verify run reads; it does not do the task. */
export const VERIFY_MAX_TURNS = 30;

/** The tools a verify run is given in place of the repo's: it reads the files and the history, and runs nothing else. */
export const VERIFY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git grep*)'];

/** Denied outright, as for a review run: the run's settings file allows Edit in its checkout. */
export const VERIFY_DENIED_TOOLS = REVIEW_DENIED_TOOLS;

/**
 * What a verify run found of a claim: `true` when the code bears it out, `false` when the code says otherwise, `stale`
 * when it was true once but the code moved on (a file moved, a function renamed, the work already done), `partly` when only
 * part of it is true.
 */
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
  /** What the code says, in a sentence or two. */
  evidence: string;
  /** For a claim that is not true, what the prompt should say instead; null when there is nothing to change. */
  fix: string | null;
}

/** A verify run's answer: its findings, none when the prompt makes no claim about the code. */
export interface VerifyAnswer {
  findings: VerifyFinding[];
}

/** The JSON schema of a verify run's answer, passed to claude with --json-schema. */
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
          evidence: { type: 'string', minLength: 1, description: 'What the code says, in a sentence or two' },
          fix: { type: 'string', description: 'For a claim that is not true: what the prompt should say instead' },
        },
        required: ['claim', 'verdict', 'path', 'line', 'evidence'],
      },
    },
  },
  required: ['findings'],
};

/** The claude arguments that make a verify run answer in VERIFY_ANSWER_SCHEMA. */
export function verifySchemaArgs(): string[] {
  return ['--json-schema', JSON.stringify(VERIFY_ANSWER_SCHEMA)];
}

/** Appended to the verify run's system prompt in place of the worker's. */
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

/**
 * The prompt of a verify run: the task's whole prompt, the commit of the base it reads, then which claims to check and how
 * to answer each.
 */
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
    '- The file and line that show it, and the evidence in a sentence or two.',
    '- For a claim that is not true, a suggested fix: what the prompt should say instead.',
    '- Leave out what the prompt asks to be done and anything that is not about the code. No findings when it makes no claims.',
  ].join('\n');
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** One finding, or null when it names no claim or a verdict that is not one of CLAIM_VERDICTS. */
function parseFinding(v: unknown): VerifyFinding | null {
  if (!isRecord(v)) return null;
  const claim = text(v.claim);
  const verdict = text(v.verdict).toLowerCase() as ClaimVerdict;
  if (!claim || !CLAIM_VERDICTS.includes(verdict)) return null;
  const line = typeof v.line === 'string' ? Number(v.line) : v.line;
  return {
    claim,
    verdict,
    path: text(v.path) || null,
    line: typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null,
    evidence: text(v.evidence),
    fix: text(v.fix) || null,
  };
}

/**
 * A verify run's answer, from its structured output or its stored result. Null when it is garbage: not an object, or no
 * list of findings. A partial answer keeps what it can: a finding with no claim or an unknown verdict is left out, and
 * one with no file, line, evidence or fix keeps the rest.
 */
export function parseVerifyAnswer(raw: unknown): VerifyAnswer | null {
  const v = answerValue(raw);
  if (!isRecord(v) || !Array.isArray(v.findings)) return null;
  return { findings: v.findings.map(parseFinding).filter((f): f is VerifyFinding => f !== null) };
}

/** Why a verify run may not start for `task` now (`runs` is its runs), or null when it may. */
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

/** A verify run's findings, read from its stored result; null for another kind or a run that left none. */
export function runFindings(run: Pick<Run, 'kind' | 'outcome' | 'result_text'>): VerifyFinding[] | null {
  if (run.kind !== 'verify' || run.outcome !== 'done') return null;
  return parseVerifyAnswer(run.result_text)?.findings ?? null;
}

/**
 * The task's latest verify run (`runs` oldest first), or null when it has none. `base` is the commit the base is at now
 * (null when unknown): findings read at another commit are stale.
 */
export function latestVerify(
  // `base_commit` may be missing from a daemon that predates it (the dashboard's Run).
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

/** The findings in one line: "4 claims: 2 true, 1 false, 1 stale", or "No claims about the code" for none. */
export function verifyLine(findings: Pick<VerifyFinding, 'verdict'>[]): string {
  if (!findings.length) return 'No claims about the code';
  const counts = CLAIM_VERDICTS.flatMap((v) => {
    const n = findings.filter((f) => f.verdict === v).length;
    return n ? [`${n} ${v}`] : [];
  });
  return `${plural(findings.length, 'claim')}: ${counts.join(', ')}`;
}

/** Where a finding points: "src/a.ts:12", "src/a.ts", or null. */
export const findingPlace = (f: Pick<VerifyFinding, 'path' | 'line'>): string | null =>
  f.path ? (f.line ? `${f.path}:${f.line}` : f.path) : null;
