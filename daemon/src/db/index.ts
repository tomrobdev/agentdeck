// The database: the only place SQL lives.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from '#src/config.ts';
import { drainStore } from '#db/capacity/drain.ts';
import { usageStore } from '#db/capacity/usage.ts';
import { changeStore } from '#db/changes.ts';
import { statsStore } from '#db/insights/stats.ts';
import { reviewStore } from '#db/landing/reviews.ts';
import { notificationStore } from '#db/operations/notifications.ts';
import { settingsStore } from '#db/operations/settings.ts';
import { makeOrm } from '#db/orm.ts';
import { plannerRunStore } from '#db/proposals/planner-runs.ts';
import { repoStore } from '#db/repos/repos.ts';
import { runStore } from '#db/runs/runs.ts';
import { migrate } from '#db/schema.ts';
import { planStore } from '#db/work/plans.ts';
import { taskEventStore } from '#db/work/task-events.ts';
import { taskLinkStore } from '#db/work/task-links.ts';
import { taskStore } from '#db/work/tasks.ts';

export { MIGRATIONS, type Migration, migrate } from '#db/schema.ts';

export type Db = ReturnType<typeof openDb>;

export function openDb(path = DB_PATH) {
  if (path === DB_PATH) ensureDirs();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  const orm = makeOrm(db);

  return {
    raw: db,
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
    ...drainStore(orm),
  };
}
