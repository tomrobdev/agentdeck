// Records notifications and sends them on the enabled channels.
import type { App } from '#application/ports/app.ts';
import type { Notifier } from '#application/ports/notifier.ts';
import { type Notification, appDelivers } from '#domain/operations/index.ts';

export type Channels = Notifier;

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

export function notifyLater(app: App, n: Notification): void {
  notify(app, n).catch((err) => console.error(`notify: ${err}`));
}
