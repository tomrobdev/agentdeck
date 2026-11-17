// Latest utilization of each usage window, as reported by Claude's rate_limit_event, and the history of its changes.
import { asc, eq } from 'drizzle-orm';
import type { Orm } from '#db/orm.ts';
import { NOW_SQL } from '#db/sql.ts';
import { usageSamples, usageWindows } from '#db/tables.ts';

export function usageStore(orm: Orm) {
  return {
    recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void {
      const observed_at = NOW_SQL;
      const last = orm.select().from(usageWindows).where(eq(usageWindows.window, window)).get();
      if (!last || last.utilization !== utilization || last.resets_at !== resets_at)
        orm.insert(usageSamples).values({ window, utilization, resets_at, observed_at }).run();
      orm
        .insert(usageWindows)
        .values({ window, utilization, resets_at, status, observed_at })
        .onConflictDoUpdate({ target: usageWindows.window, set: { utilization, resets_at, status, observed_at } })
        .run();
    },
    usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[] {
      return orm.select().from(usageWindows).orderBy(asc(usageWindows.window)).all();
    },
    usageSamples(window?: string): { window: string; utilization: number; resets_at: number; observed_at: string }[] {
      return orm
        .select({
          window: usageSamples.window,
          utilization: usageSamples.utilization,
          resets_at: usageSamples.resets_at,
          observed_at: usageSamples.observed_at,
        })
        .from(usageSamples)
        .where(window === undefined ? undefined : eq(usageSamples.window, window))
        .orderBy(asc(usageSamples.id))
        .all();
    },
  };
}
