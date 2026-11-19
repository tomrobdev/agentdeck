// Landing a plan across repos: its landing policy, which plan PR may merge next, what a merge or a PR's state leaves, and the question a partly landed plan asks.
import type { AutoMergeCheck, MergeFailure, PrState } from '#domain/landing/index.ts';
import type { LandingPolicy, PlanBranch, PlanBranchMove } from '#domain/work/plans/plan-branch.ts';

export const LANDING_POLICIES: LandingPolicy[] = ['person', 'auto', 'together', 'in_order'];

export const DEFAULT_LANDING_POLICY: LandingPolicy = 'person';

export const isLandingPolicy = (value: unknown): value is LandingPolicy => LANDING_POLICIES.includes(value as LandingPolicy);

export const daemonLands = (policy: LandingPolicy): boolean => policy !== 'person';

const isSaga = (policy: LandingPolicy): boolean => policy === 'together' || policy === 'in_order';

/** One repo's plan branch as the landing saga reads it. */
export interface LandingBranch extends Pick<PlanBranch, 'id' | 'name' | 'status' | 'land_order' | 'land_error'> {
  /** The repo's name, for a person. */
  repo: string;
  /** The plan PR's check, as the daemon read it this pass; null when there is no open plan PR or it was not read. */
  verdict: AutoMergeCheck['verdict'] | null;
  /** The check's first reason, when it waits or needs a person. */
  reason?: string | null;
}

export function landingOrder<B extends Pick<PlanBranch, 'id' | 'land_order'>>(branches: B[]): B[] {
  const rank = (b: B) => b.land_order ?? Number.MAX_SAFE_INTEGER;
  return [...branches].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

/** What the daemon does next for a plan: merge one plan PR, wait (and why), or stop the saga on one that can't land. */
export type LandingStep =
  { kind: 'merge'; branch: number } | { kind: 'wait'; reason: string } | { kind: 'fail'; branch: number; error: string } | { kind: 'none' };

const unlanded = (branches: LandingBranch[]) => landingOrder(branches.filter((b) => b.status !== 'landed' && b.status !== 'abandoned'));

const mayMerge = (b: LandingBranch): boolean => b.status === 'landing' && b.land_error === null && b.verdict === 'merge';

function notReady(b: LandingBranch): { lasting: boolean; text: string } {
  if (b.status !== 'landing') return { lasting: false, text: `${b.name} in ${b.repo} has no plan PR yet (${b.status})` };
  if (b.land_error !== null) return { lasting: true, text: `${b.name} in ${b.repo} did not merge: ${b.land_error}` };
  if (b.verdict === 'never') return { lasting: true, text: `${b.name} in ${b.repo} needs a person: ${b.reason ?? 'its PR check failed'}` };
  return { lasting: false, text: `${b.name} in ${b.repo} waits: ${b.reason ?? 'its PR is not ready'}` };
}

export function nextLandingStep(policy: LandingPolicy, branches: LandingBranch[]): LandingStep {
  const left = unlanded(branches);
  if (!left.length || !daemonLands(policy)) return { kind: 'none' };
  const partly = left.find((b) => b.status === 'partly_landed');
  if (partly) return { kind: 'wait', reason: `${partly.name} in ${partly.repo} is partly landed and waits for a person's answer` };
  if (policy === 'auto') {
    const next = left.find(mayMerge);
    return next ? { kind: 'merge', branch: next.id } : { kind: 'none' };
  }
  const started = branches.some((b) => b.status === 'landed');
  const blocker = policy === 'together' && !started ? left.find((b) => !mayMerge(b)) : left[0];
  if (!blocker || mayMerge(blocker)) return { kind: 'merge', branch: (blocker ?? left[0]).id };
  const why = notReady(blocker);
  if (started && why.lasting) return { kind: 'fail', branch: blocker.id, error: why.text };
  return { kind: 'wait', reason: why.text };
}

/** What one plan branch's row takes after a landing event: its move (if any), and its land_error. */
export interface LandingChange {
  move: PlanBranchMove | null;
  land_error: string | null;
}

const othersLanded = (branches: Pick<LandingBranch, 'id' | 'status'>[], id: number): boolean =>
  branches.some((b) => b.id !== id && b.status === 'landed');

export function afterLandingMerge(
  policy: LandingPolicy,
  branches: Pick<LandingBranch, 'id' | 'status'>[],
  id: number,
  result: { merged: true } | { failure: MergeFailure; error: string },
): LandingChange {
  if ('merged' in result) return { move: 'land', land_error: null };
  if (result.failure !== 'lasting') return { move: null, land_error: null };
  return { move: isSaga(policy) && othersLanded(branches, id) ? 'part_land' : null, land_error: result.error };
}

export function afterPlanPrState(
  policy: LandingPolicy,
  branches: Pick<LandingBranch, 'id' | 'status'>[],
  id: number,
  state: PrState,
): LandingChange | null {
  if (state === 'merged') return { move: 'land', land_error: null };
  if (state !== 'closed') return null;
  const branch = branches.find((b) => b.id === id);
  if (branch?.status === 'partly_landed') return null;
  if (isSaga(policy) && othersLanded(branches, id)) return { move: 'part_land', land_error: 'its plan PR was closed unmerged' };
  return { move: 'close_pr', land_error: null };
}

/** A person's answer to a partly landed plan. */
export type LandingAnswer = 'retry' | 'revert' | 'by_hand';

export const LANDING_ANSWERS: LandingAnswer[] = ['retry', 'revert', 'by_hand'];

export const isLandingAnswer = (value: unknown): value is LandingAnswer => LANDING_ANSWERS.includes(value as LandingAnswer);

/** The question a partly landed plan asks a person, with the answers it takes. */
export interface LandingQuestion {
  text: string;
  options: { answer: LandingAnswer; text: string }[];
}

type AskedBranch = Pick<LandingBranch, 'name' | 'repo' | 'status' | 'land_error'>;

export function landingQuestion(branches: AskedBranch[]): LandingQuestion | null {
  const partly = branches.filter((b) => b.status === 'partly_landed');
  const first = partly[0];
  if (!first) return null;
  const landed = branches.filter((b) => b.status === 'landed').map((b) => b.repo);
  const where = landed.length ? landed.join(', ') : 'no repo';
  const failed = partly.map((b) => `${b.repo} (${b.land_error ?? 'its merge failed'})`).join(', ');
  return {
    text: `${first.name} landed in ${where} but not in ${failed}. What now?`,
    options: [
      { answer: 'retry', text: `merge the plan PR in ${partly.map((b) => b.repo).join(', ')} again` },
      { answer: 'revert', text: `open a revert PR in ${where} and abandon the plan branches that have not landed` },
      { answer: 'by_hand', text: 'finish by hand: a person merges what is left, and the daemon lands no more of this plan' },
    ],
  };
}

export function landingQuestionLine(question: LandingQuestion, plan: number): string {
  const options = question.options.map((o) => `${o.answer} (${o.text})`).join(', ');
  return `${question.text} Answer with agentdeck plan-branch answer ${plan} and one of: ${options}`;
}

export function partlyLandedLine(branches: AskedBranch[], plan: number): string {
  const question = landingQuestion(branches);
  return question ? landingQuestionLine(question, plan) : `#${plan}'s plan landed in only some repos`;
}

export function landingAnswerMove(answer: LandingAnswer): PlanBranchMove {
  switch (answer) {
    case 'retry':
      return 'retry';
    case 'by_hand':
      return 'by_hand';
    case 'revert':
      return 'abandon';
  }
}

export function landingOrderError(order: string[], repos: string[]): string | null {
  const unknown = order.filter((r) => !repos.includes(r));
  if (unknown.length) return `the plan has no plan branch in ${unknown.join(', ')}; it has one in ${repos.join(', ')}`;
  if (new Set(order).size !== order.length) return 'a repo is named twice in the order';
  return null;
}

export function revertFrom(landed: string, method: 'squash' | 'merge' | 'rebase', commits: number): string {
  return method === 'rebase' ? `${landed}~${Math.max(commits, 1)}` : `${landed}^1`;
}
