// Records notifications and sends them on the enabled channels.
// Sent from the daemon so they arrive even when the dashboard is closed.
import type { App } from '../ports/app.ts';
import type { Notifier } from '../ports/notifier.ts';
import { type Notification, appDelivers } from '../../domain/operations/index.ts';

/** The ways out a notification can take besides the database: the app's notifier unless a test passes its own. */
export type Channels = Notifier;

/**
 * Record the notification and deliver it on the enabled channels. The desktop app, while it runs, shows desktop
 * notifications itself from the recorded rows, so osascript is skipped then. AGENTDECK_NO_NOTIFY=1 (used by tests)
 * records without delivering.
 */
export async function notify(app: App, n: Notification, channels: Channels = app.notifier): Promise<void> {
  const s = app.notifySettings();
  if (n.kind !== 'test' && !s.events.includes(n.kind)) return;
  app.addNotification(n.kind, n.title, n.body, n.task_id ?? null);
  if (process.env.AGENTDECK_NO_NOTIFY === '1') return;

  const jobs: Promise<void>[] = [];
  if (s.desktop && !appDelivers(app.appSeenAt(), Date.now())) jobs.push(channels.desktop(n));
  if (s.ntfy_topic) jobs.push(channels.ntfy(s, n));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error(`notify: ${r.reason}`);
}

/** Fire and forget, for call sites that must not wait or fail. */
export function notifyLater(app: App, n: Notification): void {
  notify(app, n).catch((err) => console.error(`notify: ${err}`));
}
