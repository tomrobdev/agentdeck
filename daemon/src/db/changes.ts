// SQLite's own change counters, which the change stream (application/changes.ts) watches.
import type { DatabaseSync } from 'node:sqlite';

export function changeStore(db: DatabaseSync) {
  // Raw SQL on purpose: these are pragmas and a function, not a table, so the query builder has nothing to build on.
  const dataVersion = db.prepare('PRAGMA data_version');
  const totalChanges = db.prepare('SELECT total_changes() AS n');
  return {
    /** `dataVersion` moves when another connection (the CLI, another process) commits; `ownChanges` counts this connection's writes. */
    changeCounters(): { dataVersion: number; ownChanges: number } {
      return {
        dataVersion: Number((dataVersion.get() as { data_version: number }).data_version),
        ownChanges: Number((totalChanges.get() as { n: number }).n),
      };
    },
  };
}
