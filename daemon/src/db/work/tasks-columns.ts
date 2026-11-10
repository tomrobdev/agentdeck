// What the task store's files share: a domain write's changes as columns, and the guards on a task's PR.
import { and, eq } from 'drizzle-orm';
import { stored } from '../../domain/shared/index.ts';
import type { TaskChanges } from '../../domain/work/index.ts';
import { NOW_SQL } from '../sql.ts';
import { tasks } from '../tables.ts';

export const prOpen = eq(tasks.pr_state, 'open');
export const inReview = and(eq(tasks.status, 'done'), prOpen);

export const columns = (changes: TaskChanges) => {
  const { auto_merge_checked_at, merge_requested_at, ...rest } = changes;
  return {
    ...stored(rest),
    ...(auto_merge_checked_at === undefined ? {} : { auto_merge_checked_at: auto_merge_checked_at === 'now' ? NOW_SQL : null }),
    ...(merge_requested_at === undefined ? {} : { merge_requested_at: merge_requested_at === 'now' ? NOW_SQL : null }),
  };
};

export const given = <T extends object>(fields: T) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? null])) as { [K in keyof T]-?: Exclude<T[K], undefined> };
