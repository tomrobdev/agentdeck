// Sent notifications, kept for the dashboard (the newest 200).
import { desc, lte, sql } from 'drizzle-orm';
import type { Notification } from '../domain/notification.ts';
import type { Orm } from './orm.ts';
import { notifications } from './tables.ts';

export function notificationStore(orm: Orm) {
  return {
    addNotification(kind: string, title: string, body: string, task_id: number | null): void {
      orm.insert(notifications).values({ kind, title, body, task_id }).run();
      orm
        .delete(notifications)
        .where(lte(notifications.id, sql`(SELECT MAX(id) - 200 FROM notifications)`))
        .run();
    },
    recentNotifications(
      limit = 20,
    ): { id: number; kind: Notification['kind']; title: string; body: string; task_id: number | null; created_at: string }[] {
      return orm.select().from(notifications).orderBy(desc(notifications.id)).limit(limit).all() as {
        id: number;
        kind: Notification['kind'];
        title: string;
        body: string;
        task_id: number | null;
        created_at: string;
      }[];
    },
  };
}
