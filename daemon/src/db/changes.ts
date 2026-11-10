// SQLite's own change counters, which the change stream (application/changes.ts) watches.
import type { DatabaseSync } from 'node:sqlite';

export function changeStore(db: DatabaseSync) {
  const dataVersion = db.prepare('PRAGMA data_version');
  const totalChanges = db.prepare('SELECT total_changes() AS n');
  return {
    changeCounters(): { dataVersion: number; ownChanges: number } {
      return {
        dataVersion: Number((dataVersion.get() as { data_version: number }).data_version),
        ownChanges: Number((totalChanges.get() as { n: number }).n),
      };
    },
  };
}
