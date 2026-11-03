// Alerts for things that need a human: task finished, blocked, failed, proposals, a governor hold, a pause, an
// auto-merge or a PR's checks failing. Pure: no I/O.
import type { Task } from './task/task.ts';

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'paused' | 'proposed' | 'merged' | 'checks_failed';
export const NOTIFY_KINDS: NotifyKind[] = ['done', 'blocked', 'failed', 'hold', 'paused', 'proposed', 'merged', 'checks_failed'];

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

/** How long after the desktop app last said it is running it still shows desktop notifications itself. It says so every 30 s. */
export const APP_SEEN_WINDOW_MS = 90_000;

/**
 * Whether the desktop app shows desktop notifications, in place of osascript: it does when it was seen in the last 90 s.
 * `appSeenAt` and `now` are ms since the epoch; `appSeenAt` is null when the app was never seen.
 */
export function appDelivers(appSeenAt: number | null, now: number): boolean {
  return appSeenAt !== null && now - appSeenAt < APP_SEEN_WINDOW_MS;
}

/** What a person is told when a task ends done, blocked or failed; null for any other status. `pr` is what opening its PR came to. */
export function finalNotification(
  task: Pick<Task, 'id' | 'title' | 'status' | 'branch' | 'stop_reason'>,
  repoName: string,
  pr: { url?: string; error?: string } = {},
): Notification | null {
  const { status } = task;
  if (status !== 'done' && status !== 'blocked' && status !== 'failed') return null;
  let body =
    status === 'done'
      ? `Ready to review on ${task.branch ?? 'its branch'}${repoName ? ` in ${repoName}` : ''}.`
      : `${task.stop_reason ?? status}${repoName ? ` (${repoName})` : ''}`;
  if (pr.url) body = `${body} PR: ${pr.url}`;
  if (pr.error) body = `${body} Could not open a PR: ${pr.error}`;
  return { kind: status, title: `#${task.id} ${status}: ${task.title}`, body, task_id: task.id };
}
