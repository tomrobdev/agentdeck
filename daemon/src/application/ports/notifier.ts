// The Notifier port: delivers a notification on the desktop and to ntfy.
import type { Notification, NotifySettings } from '#domain/operations/index.ts';

export interface Notifier {
  desktop(n: Notification): Promise<void>;
  ntfy(s: NotifySettings, n: Notification): Promise<void>;
}
