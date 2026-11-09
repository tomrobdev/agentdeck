// Moving through review with keys: the next task in review after a merge, the next file of a diff and its next open
// comment. Pure, so the daemon's tests can import it (daemon/test/dashboard/task/review-nav.test.ts).
import type { TaskSummary } from '../../../../daemon/src/api/contract/work.ts';
import { isReview } from '../../../../daemon/src/domain/work/index.ts';

/**
 * The next task in review after `currentId` in `order`, the queue's rows in screen order. Never the current task, and
 * not a task whose merge is already requested: that PR stays in review until the daemon merges it. After the current
 * task's place if it is in the order, else the first.
 */
export function nextInReview(order: TaskSummary[], currentId: number): TaskSummary | null {
  const eligible = (t: TaskSummary) => t.id !== currentId && isReview(t) && !t.merge_request;
  const at = order.findIndex((t) => t.id === currentId);
  return order.slice(at + 1).find(eligible) ?? order.slice(0, Math.max(at, 0)).find(eligible) ?? null;
}

/** The item `by` steps from `current` in `items`, stopping at the ends; the first (or last) when `current` is not in it. */
export function stepFrom<T>(items: T[], current: T | null, by: 1 | -1): T | null {
  if (!items.length) return null;
  const i = current === null ? -1 : items.indexOf(current);
  if (i === -1) return items[by === 1 ? 0 : items.length - 1];
  return items[Math.min(Math.max(i + by, 0), items.length - 1)];
}

interface Anchor {
  id: number;
  path: string;
  line: number;
  state: string;
}

/** The open (not resolved) comments in the diff's order: by the files' order, then line. */
export function openCommentOrder<C extends Anchor>(comments: C[], paths: string[]): C[] {
  const rank = (p: string) => paths.indexOf(p);
  return comments
    .filter((c) => c.state !== 'resolved' && rank(c.path) !== -1)
    .sort((a, b) => rank(a.path) - rank(b.path) || a.line - b.line || a.id - b.id);
}
