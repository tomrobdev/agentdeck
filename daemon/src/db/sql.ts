// SQL fragments shared by the stores.
import { sql } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';

// guard: SQLite's clock; the builder has no "now", and a column default does not apply to an update
export const NOW_SQL = sql.raw("datetime('now')");

let savepoints = 0;

/**
 * Run `fn` as one unit: all its writes land, or none do. A SAVEPOINT rather than BEGIN, so it
 * composes with a transaction the caller already holds.
 */
export function atomically<T>(db: DatabaseSync, fn: () => T): T {
  const name = `sp_${++savepoints}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}
