// Latest utilization of each usage window, as reported by Claude's rate_limit_event.
import { asc, sql } from 'drizzle-orm';
import type { Orm } from './orm.ts';
import { NOW } from './sql.ts';
import { usageWindows } from './tables.ts';

export function usageStore(orm: Orm) {
  return {
    recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void {
      const observed_at = sql`${sql.raw(NOW)}`;
      orm
        .insert(usageWindows)
        .values({ window, utilization, resets_at, status, observed_at })
        .onConflictDoUpdate({ target: usageWindows.window, set: { utilization, resets_at, status, observed_at } })
        .run();
    },
    usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[] {
      return orm.select().from(usageWindows).orderBy(asc(usageWindows.window)).all();
    },
  };
}
