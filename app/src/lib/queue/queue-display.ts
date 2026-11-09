// How the queue is shown: the saved display settings, the board's column order and the rows j and k walk through.
// Free of the dashboard's other modules so the daemon's tests can import it (daemon/test/dashboard/queue/queue-display.test.ts).
import type { TaskSummary } from '../../../../daemon/src/api/contract.ts';

export type GroupBy = 'status' | 'repo' | 'priority' | 'none';

/** What these rules read of a group of rows (taskView's `Group`). */
interface RowGroup {
  key: string;
  tasks: TaskSummary[];
}

/** Which parts of a row the list and the board show. */
export interface ShowProps {
  repo: boolean;
  pr: boolean;
  time: boolean;
  reason: boolean;
  /** The model chip; on for a display saved before it existed. */
  model: boolean;
}

export interface Display {
  mode: 'list' | 'board' | 'graph';
  groupBy: GroupBy;
  sort: string;
  show: ShowProps;
  showEmpty: boolean;
  collapsed: string[];
  /** Graph mode: also draw chains whose every task is done and merged. Missing from a saved view that predates it. */
  showFinished?: boolean;
}

export const DEFAULT_DISPLAY: Display = {
  mode: 'list',
  groupBy: 'status',
  sort: 'attention',
  show: { repo: true, pr: true, time: true, reason: true, model: true },
  showEmpty: false,
  collapsed: ['cancelled', 'done'],
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A saved display filled out with the defaults, `show` included, so a key added since it was saved gets its default.
 * `doneCollapsed` says whether the one-time collapse of Done below already ran.
 */
export function normalizeDisplay(saved: unknown, doneCollapsed = true): Display {
  const s = isObject(saved) ? (saved as Partial<Display>) : {};
  const display: Display = { ...DEFAULT_DISPLAY, ...s, show: { ...DEFAULT_DISPLAY.show, ...(isObject(s.show) ? s.show : {}) } };
  if (doneCollapsed) return display;
  // Merged is part of Done now, which holds the finished history it did: collapse Done once, then leave it to the user.
  const collapsed = display.collapsed.filter((k) => k !== 'merged');
  return { ...display, collapsed: collapsed.includes('done') ? collapsed : [...collapsed, 'done'] };
}

/** The board reads left to right as the work flows: review sits just before done. */
export function boardGroups<G extends RowGroup>(all: G[]): G[] {
  const review = all.find((g) => g.key === 'review');
  if (!review) return all;
  const rest = all.filter((g) => g !== review);
  const done = rest.findIndex((g) => g.key === 'done');
  return [...rest.slice(0, done), review, ...rest.slice(done)];
}

/** The rows in screen order, skipping collapsed groups: what j and k walk through. */
export function rowOrder(groups: RowGroup[], display: Pick<Display, 'mode' | 'groupBy' | 'collapsed'>): TaskSummary[] {
  return display.mode !== 'list'
    ? groups.flatMap((g) => g.tasks)
    : groups.filter((g) => display.groupBy === 'none' || !display.collapsed.includes(g.key)).flatMap((g) => g.tasks);
}
