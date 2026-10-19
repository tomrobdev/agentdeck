// Latest utilization of each usage window, as reported by Claude's rate_limit_event.
import type { DatabaseSync } from 'node:sqlite';
import { NOW } from './sql.ts';

export function usageStore(db: DatabaseSync) {
  return {
    recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void {
      db.prepare(
        `INSERT INTO usage_windows (window, utilization, resets_at, status, observed_at) VALUES (?, ?, ?, ?, ${NOW})
         ON CONFLICT(window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at,
           status = excluded.status, observed_at = excluded.observed_at`,
      ).run(window, utilization, resets_at, status);
    },
    usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[] {
      return db.prepare('SELECT * FROM usage_windows ORDER BY window').all() as never;
    },
  };
}
