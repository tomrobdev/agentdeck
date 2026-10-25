// Records notifications and sends them on the enabled channels.
// Sent from the daemon so they arrive even when the dashboard is closed.
import { desktop, ntfy } from '../adapters/notify.ts';
import type { Db } from '../db/index.ts';
import type { Notification } from '../domain/notification.ts';

/**
 * Record the notification and deliver it on the enabled channels.
 * AGENTDECK_NO_NOTIFY=1 (used by tests) records without delivering.
 */
export async function notify(db: Db, n: Notification): Promise<void> {
  const s = db.notifySettings();
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
