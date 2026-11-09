// How the dashboard words the daemon: its state, a stale daemon, the notification kinds and the attention list.
import type { NotifyKind, Status } from '../../api/types.ts';
import { relTime, when } from '../shared/time.ts';

/** What each notification kind is called in the settings. */
export const NOTIFY_LABELS: Record<NotifyKind, string> = {
  blocked: 'Task blocked',
  failed: 'Task failed',
  done: 'Task done',
  hold: 'Work held by budget',
  paused: 'Repo paused',
  proposed: 'Planner proposals',
  merged: 'PR auto-merged',
  checks_failed: 'PR checks failed',
  review_due: 'Area review due',
};

/** Why a task in the headline's `attention` needs a person, in a word or two. The tray menu words it the same way (`why_label` in `app/src-tauri/src/tray.rs`). */
export const ATTENTION_LABELS: Record<Status['headline']['attention'][number]['why'], string> = {
  blocked: 'blocked',
  review: 'in review',
  proposed: 'proposed',
};

/** The banner text when the daemon runs a different commit than the dashboard, else null. Unknown commits never warn. */
export function describeStaleDaemon(s: Status | null, dashboardCommit: string | null): string | null {
  const d = s?.daemon;
  if (!d?.commit || !dashboardCommit || d.commit === dashboardCommit) return null;
  const started = new Date(d.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `The daemon is running older code (${d.commit.slice(0, 7)}, started ${started}). Restart it to match the dashboard.`;
}

/** One label for the daemon's state, in the status bar. The tray words it the same way, in Rust (`tray_view` in `app/src-tauri/src/tray.rs`). */
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
    default:
      return { label: 'Idle', cls: 's-done', title: g.reason ?? '' };
  }
}
