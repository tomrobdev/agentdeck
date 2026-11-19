// A plan review: the review run over a plan branch's whole diff against its base, once its plan PR opens, and what its verdict means for landing it.
import type { MergeReasons } from '#domain/landing/index.ts';
import type { PlanBranch } from '#domain/work/plans/plan-branch.ts';

export type PlanReviewState = 'due' | 'clean' | 'blocking' | 'failed';

export const PLAN_REVIEW_STATES: PlanReviewState[] = ['due', 'clean', 'blocking', 'failed'];

export type PlanReviewMove = 'clean' | 'block' | 'fail';

export const PLAN_REVIEW_MOVES: Record<PlanReviewMove, Partial<Record<PlanReviewState, PlanReviewState>>> = {
  clean: { due: 'clean' },
  block: { due: 'blocking' },
  fail: { due: 'failed' },
};

export const nextPlanReviewState = (from: PlanReviewState, move: PlanReviewMove): PlanReviewState | null =>
  PLAN_REVIEW_MOVES[move][from] ?? null;

export const planReviewStatesFor = (move: PlanReviewMove): PlanReviewState[] => Object.keys(PLAN_REVIEW_MOVES[move]) as PlanReviewState[];

export const planReviewMoveOf = (verdict: 'clean' | 'blocking' | null): PlanReviewMove =>
  verdict === null ? 'fail' : verdict === 'clean' ? 'clean' : 'block';

export const planReviewDue = (branch: Pick<PlanBranch, 'status' | 'pr_url' | 'review'>): boolean =>
  branch.status === 'landing' && branch.pr_url !== null && branch.review === 'due';

export function planReviewReasons(branch: Pick<PlanBranch, 'review'>): MergeReasons {
  switch (branch.review) {
    case 'due':
      return { never: [], wait: [{ kind: 'review_pending', text: 'the plan review run has not read the plan PR yet' }] };
    case 'blocking':
      return { never: [{ kind: 'review_blocking', text: 'the plan review run found a blocking finding' }], wait: [] };
    case 'failed':
      return { never: [{ kind: 'review_failed', text: 'the plan review run gave no answer, so a person reads the plan PR' }], wait: [] };
    case 'clean':
    case null:
      return { never: [], wait: [] };
  }
}
