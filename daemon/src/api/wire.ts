// Tasks as the API sends them. The domain keeps a task's `needs`, `question` and `plan_steps` as values and its flags as booleans;
// the API keeps the shape it always had (JSON text, 1 or 0), so the dashboard reads them as before.
import * as actions from '../application/actions.ts';
import type { Db } from '../db/index.ts';
import { stored } from '../db/mappers.ts';

/** One task with its view, runs, events and plans, in the API's shape. */
export async function taskDetail(db: Db, id: number) {
  const detail = await actions.taskDetail(db, id);
  return { ...stored(detail), runs: detail.runs.map(stored) };
}

/** Task summaries, each with its view, in the API's shape. */
export function taskViews(db: Db, filter: Parameters<typeof actions.taskViews>[1]) {
  return actions.taskViews(db, filter).map(stored);
}
