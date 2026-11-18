// What is under way, for the status bar's activity pill: running tasks, syncs, merge requests and planner runs.
import { describeMergeRequest } from '#lib/landing/landing-wording.ts';
import { describeLive, describeSync } from '#lib/runs/run-wording.ts';
import { parseTime } from '#lib/shared/time.ts';
import type { Status, TaskSummary } from '#api/types.ts';

type TaskTab = 'overview' | 'runs';

export type ActivityKind = 'run' | 'sync' | 'resolve' | 'merge' | 'planner';

export interface ActivityItem {
  key: string;
  kind: ActivityKind;
  taskId: number | null;
  title: string;
  doing: string;
  took: string | null;
  tab: TaskTab;
  cancellable: boolean;
}

function since(time: string, now: number): string {
  const secs = Math.max(0, (now - parseTime(time)) / 1000);
  return secs < 90 ? `${Math.round(secs)}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
}

export const KIND_LABEL: Record<ActivityKind, string> = {
  run: 'Run',
  sync: 'Sync',
  resolve: 'Resolve run',
  merge: 'Merge',
  planner: 'Planner',
};

export function activityItems(tasks: TaskSummary[], status: Status | null, now = Date.now()): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const t of tasks) {
    if ((t.status === 'running' || t.status === 'cancel_requested') && t.live) {
      items.push({
        key: `run-${t.id}`,
        kind: 'run',
        taskId: t.id,
        title: t.title,
        doing: t.status === 'cancel_requested' ? 'Cancelling…' : describeLive(t.live),
        took: since(t.live.since, now),
        tab: 'runs',
        cancellable: false,
      });
    } else if (t.status === 'running' || t.status === 'cancel_requested') {
      items.push({
        key: `run-${t.id}`,
        kind: 'run',
        taskId: t.id,
        title: t.title,
        doing: t.status === 'cancel_requested' ? 'Cancelling…' : 'Starting…',
        took: null,
        tab: 'runs',
        cancellable: false,
      });
    }
    if (t.sync) {
      items.push({
        key: `sync-${t.id}`,
        kind: t.sync.resolving ? 'resolve' : 'sync',
        taskId: t.id,
        title: t.title,
        doing: describeSync(t.sync),
        took: t.sync.since ? since(t.sync.since, now) : null,
        tab: t.sync.resolving ? 'runs' : 'overview',
        cancellable: false,
      });
    }
    if (t.merge_request) {
      items.push({
        key: `merge-${t.id}`,
        kind: 'merge',
        taskId: t.id,
        title: t.title,
        doing: describeMergeRequest(t.merge_request),
        took: since(t.merge_request.since, now),
        tab: 'overview',
        cancellable: true,
      });
    }
  }
  for (const p of status?.planning ?? []) {
    items.push({
      key: `planner-${p.id}`,
      kind: 'planner',
      taskId: null,
      title: p.repo,
      doing: 'Proposing tasks from the goals…',
      took: since(p.started_at, now),
      tab: 'overview',
      cancellable: false,
    });
  }
  return items;
}
