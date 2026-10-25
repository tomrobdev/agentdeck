// Sent notifications, kept for the dashboard (the newest 200).
import type { DatabaseSync } from 'node:sqlite';
import type { Notification } from '../domain/notification.ts';

export function notificationStore(db: DatabaseSync) {
  return {
    addNotification(kind: string, title: string, body: string, task_id: number | null): void {
      db.prepare('INSERT INTO notifications (kind, title, body, task_id) VALUES (?, ?, ?, ?)').run(kind, title, body, task_id);
      db.prepare('DELETE FROM notifications WHERE id <= (SELECT MAX(id) - 200 FROM notifications)').run();
    },
    recentNotifications(
      limit = 20,
    ): { id: number; kind: Notification['kind']; title: string; body: string; task_id: number | null; created_at: string }[] {
      return db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit) as never;
    },
  };
}
