// Alerts for things that need a human: task finished, blocked, failed, proposals, a governor hold or a pause. Pure: no I/O.

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'paused' | 'proposed';
export const NOTIFY_KINDS: NotifyKind[] = ['done', 'blocked', 'failed', 'hold', 'paused', 'proposed'];

/** The rules for the notification settings. Each returns the message to show, or null. */
export function notifyEventsError(events: string[]): string | null {
  const bad = events.filter((e) => !NOTIFY_KINDS.includes(e as NotifyKind));
  return bad.length ? `unknown notification events: ${bad.join(', ')}` : null;
}

/** An ntfy topic is empty (off) or letters, digits, - and _ (up to 64). */
export function ntfyTopicError(topic: string): string | null {
  return !topic || /^[\w-]{1,64}$/.test(topic) ? null : 'ntfy topic: letters, digits, - and _ only';
}

export function ntfyServerError(server: string): string | null {
  return /^https?:\/\/\S+$/.test(server) ? null : 'ntfy server must be an http(s) URL';
}

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
