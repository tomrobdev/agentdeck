// The database: the only place SQL lives. One store per table group, merged into one `Db`.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from '../config.ts';
import { notificationStore } from './notifications.ts';
import { planStore } from './plans.ts';
import { plannerRunStore } from './planner-runs.ts';
import { repoStore } from './repos.ts';
import { runStore } from './runs.ts';
import { migrate } from './schema.ts';
import { settingsStore } from './settings.ts';
import { taskStore } from './tasks.ts';
import { usageStore } from './usage.ts';

export { MIGRATIONS, type Migration, migrate } from './schema.ts';

export type Db = ReturnType<typeof openDb>;

export function openDb(path = DB_PATH) {
  if (path === DB_PATH) ensureDirs();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);

  return {
    raw: db,
    close: () => db.close(),
    ...settingsStore(db),
    ...repoStore(db),
    ...taskStore(db),
    ...runStore(db),
    ...planStore(db),
    ...plannerRunStore(db),
    ...notificationStore(db),
    ...usageStore(db),
  };
}
