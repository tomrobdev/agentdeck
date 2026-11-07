// Tasks as the API sends them. The domain keeps a task's `needs`, `question` and `plan_steps` as values, its flags as booleans and its
// pull request as one value; the API keeps the shape it always had (JSON text, 1 or 0, flat PR fields), so the dashboard reads them as before.
import * as actions from '../application/actions.ts';
import type { Db } from '../db/index.ts';
import { stored } from '../db/mappers.ts';
import { type PullRequest, prFields } from '../domain/pull-request/pr.ts';

/** A task's fields in the API's shape: stored as their columns are, with its pull request flat. */
const flat = <T extends { pr: PullRequest | null }>({ pr, ...fields }: T) => stored({ ...fields, ...prFields(pr) });

/** One task with its view, runs, events and plans, in the API's shape. */
export async function taskDetail(db: Db, id: number) {
  const detail = await actions.taskDetail(db, id);
  return { ...flat(detail), runs: detail.runs.map(stored) };
}

/** Task summaries, each with its view, in the API's shape. The checks are summed up in `checks`, so their list stays out. */
export function taskViews(db: Db, filter: Parameters<typeof actions.taskViews>[1]) {
  return actions.taskViews(db, filter).map(({ pr, ...task }) => {
    const { pr_checks: _pr_checks, ...fields } = flat({ ...task, pr });
    return fields;
  });
}
