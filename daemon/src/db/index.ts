// The database: the only place SQL lives. One store per table group, in a folder per context, merged into one `Db`.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from '../config.ts';
import { usageStore } from './capacity/usage.ts';
import { changeStore } from './changes.ts';
import { statsStore } from './insights/stats.ts';
import { reviewStore } from './landing/reviews.ts';
import { notificationStore } from './operations/notifications.ts';
import { settingsStore } from './operations/settings.ts';
import { makeOrm } from './orm.ts';
import { plannerRunStore } from './proposals/planner-runs.ts';
import { repoStore } from './repos/repos.ts';
import { runStore } from './runs/runs.ts';
import { migrate } from './schema.ts';
import { planStore } from './work/plans.ts';
import { taskEventStore } from './work/task-events.ts';
import { taskLinkStore } from './work/task-links.ts';
import { taskStore } from './work/tasks.ts';

export { MIGRATIONS, type Migration, migrate } from './schema.ts';

export type Db = ReturnType<typeof openDb>;

export function openDb(path = DB_PATH) {
  if (path === DB_PATH) ensureDirs();
  const db = new DatabaseSync(path);
  // busy_timeout first, so switching to WAL waits on another process too.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  const orm = makeOrm(db);

  return {
    raw: db, // for tests that seed or inspect rows directly; nothing in src/ outside db/ uses it
    close: () => db.close(),
    ...changeStore(db),
    ...settingsStore(db, orm),
    ...repoStore(db, orm),
    ...taskStore(db, orm),
    ...taskLinkStore(orm),
    ...taskEventStore(orm),
    ...reviewStore(orm),
    ...runStore(orm),
    ...statsStore(orm),
    ...planStore(db, orm),
    ...plannerRunStore(orm),
    ...notificationStore(orm),
    ...usageStore(orm),
  };
}
