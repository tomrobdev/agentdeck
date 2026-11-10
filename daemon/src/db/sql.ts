// SQL fragments shared by the stores.
import { inArray, isNull, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { DatabaseSync } from 'node:sqlite';
import type { Orm } from './orm.ts';
import { repos } from './tables.ts';

// guard: SQLite's clock; the builder has no "now", and a column default does not apply to an update
export const NOW_SQL = sql.raw("datetime('now')");

export const changed = (res: { changes: number | bigint }) => Number(res.changes) > 0;

export const inActiveRepo = (orm: Orm, col: AnySQLiteColumn) =>
  inArray(col, orm.select({ id: repos.id }).from(repos).where(isNull(repos.archived_at)));

let savepoints = 0;

export function atomically<T>(db: DatabaseSync, fn: () => T): T {
  if (!db.isTransaction) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
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
