// Each table's row, as Drizzle infers it from tables.ts, must equal its domain type, so a column added to one and
// not the other fails `pnpm typecheck`. Columns a domain type leaves out on purpose are named in the Omit.
import type { PlannerRun } from '../domain/planner/proposals.ts';
import type { Review, ReviewComment } from '../domain/review/review.ts';
import type { Repo } from '../domain/repo/repo.ts';
import type { Run } from '../domain/run/run.ts';
import type { TaskEventRow } from '../domain/task/history.ts';
import type { Task } from '../domain/task/task.ts';
import type { plannerRuns, repos, reviewComments, reviews, runs, taskEvents, tasks } from './tables.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compares the keys and whether each is nullable; unions such as PrMode narrow string columns. */
type Shape<T> = { [K in keyof T]-?: null extends T[K] ? 'nullable' : 'required' };
type Same<Row, Domain> = Equals<Shape<Row>, Shape<Domain>>;
export const check = <T extends true>(): T => true as T;

check<Same<typeof repos.$inferSelect, Repo>>();
// after_task: legacy, copied into task_links by migration 18; the store never reads or writes it.
check<Same<Omit<typeof tasks.$inferSelect, 'after_task'>, Task>>();
check<Same<typeof runs.$inferSelect, Run>>();
check<Same<typeof plannerRuns.$inferSelect, PlannerRun>>();
check<Same<typeof taskEvents.$inferSelect, TaskEventRow>>();
check<Same<typeof reviews.$inferSelect, Review>>();
check<Same<typeof reviewComments.$inferSelect, ReviewComment>>();
