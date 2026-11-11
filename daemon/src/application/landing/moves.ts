// Moving a task's pull request and merge request by their rule tables: a move the table doesn't allow is logged and ignored, never written.
import type { App } from '../ports/app.ts';
import type { MergeRequestMove, PrFrom, PrState } from '../../domain/landing/index.ts';
import { mergeRequestStateOf, nextMergeRequestState, nextPrState, prFrom } from '../../domain/landing/index.ts';
import { type PrEvent, type Task, prMoveOf } from '../../domain/work/index.ts';

const logError = (msg: string) => console.error(msg);

export function movePr(
  app: App,
  task: Task,
  e: PrEvent,
  log: (msg: string) => void = logError,
  from: PrFrom = prFrom(task.pr?.state),
): PrState | null {
  const move = prMoveOf(e);
  const to = nextPrState(from, move);
  if (to === null) {
    log(`task ${task.id}: PR move ${move} from ${from} is not in the table, ignored`);
    return null;
  }
  return app.recordPr(task.id, e) ? to : null;
}

export function endMergeRequest(
  app: App,
  task: Task,
  move: Exclude<MergeRequestMove, 'asked'>,
  log: (msg: string) => void = logError,
): boolean {
  const from = mergeRequestStateOf(task.pr);
  if (nextMergeRequestState(from, move) === null) {
    log(`task ${task.id}: merge request move ${move} from ${from} is not in the table, ignored`);
    return false;
  }
  return app.clearMergeRequest(task.id, move);
}
