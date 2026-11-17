// Alerts for things that need a human: task finished, blocked, failed, proposals, a governor hold, a pause, an auto-merge, a PR's checks failing or an area review due.
import { type PrCheck, failingChecks, failureLine, failureRead } from '#domain/landing/index.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { plural } from '#domain/shared/index.ts';
import type { Task, TaskState } from '#domain/work/index.ts';

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

export function notifyEventsError(events: string[]): string | null {
  const bad = events.filter((e) => !NOTIFY_KINDS.includes(e as NotifyKind));
  return bad.length ? `unknown notification events: ${bad.join(', ')}` : null;
}

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

export const APP_SEEN_WINDOW_MS = 90_000;

export function appDelivers(appSeenAt: number | null, now: number): boolean {
  return appSeenAt !== null && now - appSeenAt < APP_SEEN_WINDOW_MS;
}

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

export function prNeedsPersonNotification(task: { id: TaskId; title: string }, failures: number, error: string): Notification {
  return {
    kind: 'done',
    title: `Could not open the PR of #${task.id}`,
    body: `${plural(failures, 'try', 'tries')} failed on ${task.title}: ${error}. Open it with agentdeck open-pr ${task.id}.`,
    task_id: task.id,
  };
}

export function checksFailedNotification(task: { id: TaskId; title: string }, checks: PrCheck[]): Notification {
  const failing = failingChecks(checks);
  return {
    kind: 'checks_failed',
    title: `Checks failed on #${task.id}`,
    body: `${plural(failing.length, 'check')} failing on ${task.title}: ${failing.map(failureLine).join(failing.some(failureRead) ? '; ' : ', ')}`,
    task_id: task.id,
  };
}

export const canStart = (unblocked: TaskId[]): string =>
  unblocked.length ? `; ${unblocked.map((n) => `#${n}`).join(', ')} can start` : '';

export function mergedNotification(task: { id: TaskId; title: string }, repoName: string, unblocked: TaskId[]): Notification {
  return { kind: 'merged', title: `Merged #${task.id}`, body: `${task.title} (${repoName})${canStart(unblocked)}`, task_id: task.id };
}

export function mergeFailedNotification(id: TaskId, why: string): Notification {
  return { kind: 'merged', title: `Could not merge #${id}`, body: why, task_id: id };
}
