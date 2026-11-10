// Ids as branded numbers.

declare const brand: unique symbol;
type Brand<Name extends string> = number & { readonly [brand]: Name };

export type TaskId = Brand<'task'>;
export type RepoId = Brand<'repo'>;
export type RunId = Brand<'run'>;
export type ReviewId = Brand<'review'>;
export type PlannerRunId = Brand<'planner-run'>;

export function parseId<T extends number>(value: unknown): T | null {
  const n = typeof value === 'string' && /^#?\d+$/.test(value) ? Number(value.replace('#', '')) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? (n as T) : null;
}

export const asTaskId = (n: number): TaskId => n as TaskId;
export const asRepoId = (n: number): RepoId => n as RepoId;
export const asRunId = (n: number): RunId => n as RunId;
export const asReviewId = (n: number): ReviewId => n as ReviewId;
export const asPlannerRunId = (n: number): PlannerRunId => n as PlannerRunId;
