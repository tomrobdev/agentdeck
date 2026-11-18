// How the dashboard words the daemon: its state, a stale daemon, the notification kinds and the attention list.
import type { NotifyKind, Status } from '#api/types.ts';
import { relTime, when } from '#lib/shared/time.ts';

export const NOTIFY_LABELS: Record<NotifyKind, string> = {
  blocked: 'Task blocked',
  failed: 'Task failed',
  done: 'Task done',
  hold: 'Work held by budget',
  paused: 'Repo paused',
  drained: 'Drained and paused',
  proposed: 'Planner proposals',
  merged: 'PR auto-merged',
  checks_failed: 'PR checks failed',
  review_due: 'Area review due',
};

export const ATTENTION_LABELS: Record<Status['headline']['attention'][number]['why'], string> = {
  blocked: 'blocked',
  review: 'in review',
  proposed: 'proposed',
};

export function describeStaleDaemon(s: Status | null, dashboardCommit: string | null): string | null {
  const d = s?.daemon;
  if (!d?.commit || !dashboardCommit || d.commit === dashboardCommit) return null;
  const started = new Date(d.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `The daemon is running older code (${d.commit.slice(0, 7)}, started ${started}). Restart it to match the dashboard.`;
}

export function describeState(s: Status | null, offline: boolean): { label: string; cls: string; title: string } {
  if (offline) return { label: 'Daemon offline', cls: 's-failed', title: '' };
  if (!s) return { label: 'Connecting…', cls: 's-queued', title: '' };
  const { state, until } = s.headline;
  const g = s.governor;
  switch (state) {
    case 'paused':
      return { label: 'Paused', cls: 's-blocked', title: 'No new tasks start until you resume' };
    case 'rate_limited':
      return {
        label: `Rate limited · ${until ? relTime(until) : ''}`,
        cls: 's-blocked',
        title: 'Claude rejected a request; waiting for the window to reset',
      };
    case 'hold':
      return { label: until ? `On hold · until ${when(until)}` : 'On hold', cls: 's-blocked', title: `Usage budget: ${g.reason}` };
    case 'working':
      return { label: 'Working', cls: 's-running', title: g.reason ?? '' };
    case 'idle':
      return { label: 'Idle', cls: 's-done', title: g.reason ?? '' };
  }
}
