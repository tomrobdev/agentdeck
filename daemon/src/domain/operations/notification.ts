// Alerts for things that need a human: task finished, blocked, failed, proposals, a governor hold, a pause, an
// auto-merge, a PR's checks failing or an area review due. Pure: no I/O.
import { type PrCheck, failingChecks, failureLine, failureRead } from '../landing/index.ts';
import type { TaskId } from '../shared/index.ts';
import { plural } from '../shared/index.ts';
import type { Task, TaskState } from '../work/index.ts';

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'paused' | 'proposed' | 'merged' | 'checks_failed' | 'review_due';
export const NOTIFY_KINDS: NotifyKind[] = [
  'done',
  'blocked',
  'failed',
  'hold',
  'paused',
  'proposed',
  'merged',
  'checks_failed',
  'review_due',
];

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
  task_id?: TaskId | null;
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
  task: Pick<Task, 'id' | 'title' | 'checkout'> & TaskState,
  repoName: string,
  pr: { url?: string; error?: string } = {},
): Notification | null {
  const { status } = task;
  if (status !== 'done' && status !== 'blocked' && status !== 'failed') return null;
  let body =
    status === 'done'
      ? `Ready to review on ${task.checkout?.branch ?? 'its branch'}${repoName ? ` in ${repoName}` : ''}.`
      : `${task.stop_reason ?? status}${repoName ? ` (${repoName})` : ''}`;
  if (pr.url) body = `${body} PR: ${pr.url}`;
  if (pr.error) body = `${body} Could not open a PR: ${pr.error}`;
  return { kind: status, title: `#${task.id} ${status}: ${task.title}`, body, task_id: task.id };
}

/** What a person is told when the PR refresh has used up its retries of a PR that won't open: the last error, and how to try again. */
export function prNeedsPersonNotification(task: { id: TaskId; title: string }, failures: number, error: string): Notification {
  return {
    kind: 'done',
    title: `Could not open the PR of #${task.id}`,
    body: `${plural(failures, 'try', 'tries')} failed on ${task.title}: ${error}. Open it with agentdeck open-pr ${task.id}.`,
    task_id: task.id,
  };
}

/** What a person is told when a PR's checks fail: each failing check, with its failed step and what failed when it was read. */
export function checksFailedNotification(task: { id: TaskId; title: string }, checks: PrCheck[]): Notification {
  const failing = failingChecks(checks);
  return {
    kind: 'checks_failed',
    title: `Checks failed on #${task.id}`,
    body: `${plural(failing.length, 'check')} failing on ${task.title}: ${failing.map(failureLine).join(failing.some(failureRead) ? '; ' : ', ')}`,
    task_id: task.id,
  };
}

/** The tasks a merge lets start, as the merge's log line and notification end: "; #4, #5 can start", or nothing. */
export const canStart = (unblocked: TaskId[]): string =>
  unblocked.length ? `; ${unblocked.map((n) => `#${n}`).join(', ')} can start` : '';

/** What a person is told when the daemon merged a task's PR, on its own or as they asked: the task, its repo and the tasks it lets start. */
export function mergedNotification(task: { id: TaskId; title: string }, repoName: string, unblocked: TaskId[]): Notification {
  return { kind: 'merged', title: `Merged #${task.id}`, body: `${task.title} (${repoName})${canStart(unblocked)}`, task_id: task.id };
}

/** What a person is told when the daemon could not merge a task's PR, or dropped its merge request: why. */
export function mergeFailedNotification(id: TaskId, why: string): Notification {
  return { kind: 'merged', title: `Could not merge #${id}`, body: why, task_id: id };
}
