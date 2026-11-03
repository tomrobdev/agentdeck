// Records notifications and sends them on the enabled channels.
// Sent from the daemon so they arrive even when the dashboard is closed.
import { desktop, ntfy } from '../adapters/notify.ts';
import type { Db } from '../db/index.ts';
import { type Notification, appDelivers } from '../domain/notification.ts';

/** The ways out a notification can take besides the database. Tests pass their own. */
export interface Channels {
  desktop: typeof desktop;
  ntfy: typeof ntfy;
}

/**
 * Record the notification and deliver it on the enabled channels. The desktop app, while it runs, shows desktop
 * notifications itself from the recorded rows, so osascript is skipped then. AGENTDECK_NO_NOTIFY=1 (used by tests)
 * records without delivering.
 */
export async function notify(db: Db, n: Notification, channels: Channels = { desktop, ntfy }): Promise<void> {
  const s = db.notifySettings();
  if (n.kind !== 'test' && !s.events.includes(n.kind)) return;
  db.addNotification(n.kind, n.title, n.body, n.task_id ?? null);
  if (process.env.AGENTDECK_NO_NOTIFY === '1') return;

  const jobs: Promise<void>[] = [];
  if (s.desktop && !appDelivers(db.appSeenAt(), Date.now())) jobs.push(channels.desktop(n));
  if (s.ntfy_topic) jobs.push(channels.ntfy(s, n));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error(`notify: ${r.reason}`);
}

/** Fire and forget, for call sites that must not wait or fail. */
export function notifyLater(db: Db, n: Notification): void {
  notify(db, n).catch((err) => console.error(`notify: ${err}`));
}
