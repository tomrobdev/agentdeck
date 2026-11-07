// Ids as branded numbers. Pure. A brand is erased at runtime: a `TaskId` is a number, but the compiler will not take a `RepoId` where a
// `TaskId` is wanted. An id is made once, where it enters: an entry point parses what a person typed (`parseTaskIds`, `parseId`), and
// a store reads it from a row. Everything between passes it on.

declare const brand: unique symbol;
type Brand<Name extends string> = number & { readonly [brand]: Name };

export type TaskId = Brand<'task'>;
export type RepoId = Brand<'repo'>;
export type RunId = Brand<'run'>;
export type ReviewId = Brand<'review'>;
export type PlannerRunId = Brand<'planner-run'>;

/** A whole number above 0, or null: what an id looks like before it is known to name anything. */
export function parseId<T extends number>(value: unknown): T | null {
  const n = typeof value === 'string' && /^#?\d+$/.test(value) ? Number(value.replace('#', '')) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? (n as T) : null;
}

export const asTaskId = (n: number): TaskId => n as TaskId;
export const asRepoId = (n: number): RepoId => n as RepoId;
export const asRunId = (n: number): RunId => n as RunId;
export const asReviewId = (n: number): ReviewId => n as ReviewId;
export const asPlannerRunId = (n: number): PlannerRunId => n as PlannerRunId;
