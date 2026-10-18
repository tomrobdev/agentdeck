// Alerts for things that need a human: task finished, blocked, failed, or work held by the governor.
// Sent from the daemon so they arrive even when the dashboard is closed.
import { execFile } from 'node:child_process';
import type { Db } from './db.ts';

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'proposed';
export const NOTIFY_KINDS: NotifyKind[] = ['done', 'blocked', 'failed', 'hold', 'proposed'];

export interface Notification {
  kind: NotifyKind | 'test';
  title: string;
  body: string;
  task_id?: number | null;
}

export interface NotifySettings {
  desktop: boolean;
  events: NotifyKind[];
  ntfy_topic: string;
  ntfy_server: string;
}

export function notifySettings(db: Db): NotifySettings {
  return {
    desktop: db.getSetting('notify_desktop', '1') === '1',
    events: db.getSetting('notify_events', 'done,blocked,failed,hold,proposed').split(',').filter(Boolean) as NotifyKind[],
    ntfy_topic: db.getSetting('ntfy_topic', ''),
    ntfy_server: db.getSetting('ntfy_server', 'https://ntfy.sh'),
  };
}

/** AppleScript string literal. */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function desktop(n: Notification): Promise<void> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `display notification ${q(n.body)} with title "AgentDeck" subtitle ${q(n.title)}`], () => resolve());
  });
}

const NTFY_TAGS: Record<Notification['kind'], string> = {
  done: 'white_check_mark',
  blocked: 'raising_hand',
  failed: 'x',
  hold: 'hourglass',
  proposed: 'memo',
  test: 'bell',
};

async function ntfy(s: NotifySettings, n: Notification): Promise<void> {
  // JSON publishing keeps titles UTF-8 safe (headers would not be).
  const res = await fetch(s.ntfy_server.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: s.ntfy_topic,
      title: `AgentDeck: ${n.title}`,
      message: n.body,
      tags: [NTFY_TAGS[n.kind]],
      priority: n.kind === 'blocked' || n.kind === 'failed' ? 4 : 3,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}

/**
 * Record the notification and deliver it on the enabled channels.
 * AGENTDECK_NO_NOTIFY=1 (used by tests) records without delivering.
 */
export async function notify(db: Db, n: Notification): Promise<void> {
  const s = notifySettings(db);
  if (n.kind !== 'test' && !s.events.includes(n.kind)) return;
  db.addNotification(n.kind, n.title, n.body, n.task_id ?? null);
  if (process.env.AGENTDECK_NO_NOTIFY === '1') return;

  const jobs: Promise<void>[] = [];
  if (s.desktop) jobs.push(desktop(n));
  if (s.ntfy_topic) jobs.push(ntfy(s, n));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error(`notify: ${r.reason}`);
}

/** Fire and forget, for call sites that must not wait or fail. */
export function notifyLater(db: Db, n: Notification): void {
  notify(db, n).catch((err) => console.error(`notify: ${err}`));
}
