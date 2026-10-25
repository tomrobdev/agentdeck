// Alerts for things that need a human: task finished, blocked, failed, proposals, a governor hold or a pause. Pure: no I/O.

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'paused' | 'proposed';
export const NOTIFY_KINDS: NotifyKind[] = ['done', 'blocked', 'failed', 'hold', 'paused', 'proposed'];

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
