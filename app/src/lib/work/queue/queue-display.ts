// How the queue is shown: the saved display settings, the board's column order and the rows j and k walk through.
import type { TaskSummary } from '#daemon/api/contract/work.ts';

export type GroupBy = 'status' | 'parent' | 'repo' | 'priority' | 'none';

interface RowGroup {
  key: string;
  tasks: TaskSummary[];
}

export interface ShowProps {
  repo: boolean;
  pr: boolean;
  time: boolean;
  reason: boolean;
  model: boolean;
}

export interface Display {
  mode: 'list' | 'board' | 'graph' | 'running';
  groupBy: GroupBy;
  sort: string;
  show: ShowProps;
  showEmpty: boolean;
  collapsed: string[];
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

export function normalizeDisplay(saved: unknown, doneCollapsed = true): Display {
  const s = isObject(saved) ? (saved as Partial<Display>) : {};
  const display: Display = { ...DEFAULT_DISPLAY, ...s, show: { ...DEFAULT_DISPLAY.show, ...(isObject(s.show) ? s.show : {}) } };
  if (doneCollapsed) return display;
  const collapsed = display.collapsed.filter((k) => k !== 'merged');
  return { ...display, collapsed: collapsed.includes('done') ? collapsed : [...collapsed, 'done'] };
}

export function boardGroups<G extends RowGroup>(all: G[]): G[] {
  const review = all.find((g) => g.key === 'review');
  if (!review) return all;
  const rest = all.filter((g) => g !== review);
  const done = rest.findIndex((g) => g.key === 'done');
  return [...rest.slice(0, done), review, ...rest.slice(done)];
}

export function rowOrder(groups: RowGroup[], display: Pick<Display, 'mode' | 'groupBy' | 'collapsed'>): TaskSummary[] {
  return display.mode !== 'list'
    ? groups.flatMap((g) => g.tasks)
    : groups.filter((g) => display.groupBy === 'none' || !display.collapsed.includes(g.key)).flatMap((g) => g.tasks);
}
