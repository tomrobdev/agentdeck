// The Notifier port: delivers a notification on the desktop and to ntfy. The use case records it. The real
// adapter is adapters/notify.ts (compose.ts); tests pass their own.
import type { Notification, NotifySettings } from '../../domain/operations/index.ts';

export interface Notifier {
  /** Show it on the desktop. Never rejects. */
  desktop(n: Notification): Promise<void>;
  /** Publish it to the ntfy topic in the settings. Rejects when the server refuses. */
  ntfy(s: NotifySettings, n: Notification): Promise<void>;
}
