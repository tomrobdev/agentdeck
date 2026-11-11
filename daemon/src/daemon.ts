// The daemon's composition root: wires the source watcher, the API and the scheduler together and runs until stopped.
import { startApi } from '#api/server.ts';
import { join } from 'node:path';
import { type ComposedApp, isPaused, maxConcurrent, reloadOnChange } from '#application/actions.ts';
import { ChangeWatcher } from '#application/operations/changes.ts';
import { reloadBlock } from '#application/operations/reload-block.ts';
import { Scheduler } from '#application/scheduler/scheduler.ts';
import { API_PORT, DEFAULTS } from '#src/config.ts';
import { type Activity, SCHEMA_DIRTY, offMain, reloadDecision, runOnceRefusal } from '#domain/operations/index.ts';

export interface DaemonOptions {
  db: ComposedApp;
  once: boolean;
  log?: (line: string) => void;
  exit: (code: number) => void;
}

export async function runDaemon({ db, once, log = () => {}, exit }: DaemonOptions): Promise<void> {
  if (once) {
    const refusal = runOnceRefusal(await db.service.daemonState(API_PORT), API_PORT);
    if (refusal) throw new Error(refusal);
  }
  const info = { commit: await db.source.commit(import.meta.dirname), started_at: new Date().toISOString(), pid: process.pid };
  const stamped = (line: string) => log(`[${new Date().toISOString()}] ${line}`);
  let restartRequested = false;
  const changed: string[] = [];
  let lastChangeAt: number | null = null;
  const block = reloadBlock(
    async () => {
      const [dirty, branch] = await Promise.all([
        db.source.dirty(join(import.meta.dirname, 'db', 'schema.ts')),
        db.source.branch(import.meta.dirname),
      ]);
      return dirty ? SCHEMA_DIRTY : branch && branch !== 'main' ? offMain(branch) : null;
    },
    { onNew: (next) => log(`not reloading: ${next}`) },
  );
  if (!once) {
    db.source.watch(import.meta.dirname, (file) => {
      if (!changed.includes(file)) changed.push(file);
      lastChangeAt = Date.now();
      void block.refresh().catch(() => {});
    });
  }
  const reload = once
    ? undefined
    : {
        check: (activity: Activity) => {
          block.recheck();
          return reloadDecision({
            enabled: reloadOnChange(db),
            changed,
            lastChangeAt,
            now: Date.now(),
            activity,
            requested: restartRequested,
            blocked: block.reason,
          });
        },
        exit: () => exit(0),
      };
  const scheduler = new Scheduler(db, { once, keepAwake: !once, reload });
  const changes = once ? undefined : new ChangeWatcher(db);
  changes?.onOtherProcess(() => scheduler.wake());
  changes?.start();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stamped(`${sig}: stopping workers; their tasks will be requeued on next start`);
      changes?.stop();
      scheduler.stop();
      exit(0);
    });
  }
  if (!once) {
    const requestRestart = () => {
      restartRequested = true;
      setTimeout(() => scheduler.wake(), 200);
    };
    const reloadFacts = () => ({ changed, lastChangeAt, requested: restartRequested, blocked: block.reason });
    const api = await startApi({ db, port: API_PORT, scheduler, changes, daemon: { info, requestRestart, reloadFacts } }).catch((err) => {
      if (err?.code === 'EADDRINUSE')
        throw new Error(`port ${API_PORT} is in use: another agentdeck daemon is probably running (see \`agentdeck service\`)`);
      throw err;
    });
    stamped(`api        http://127.0.0.1:${API_PORT}`);
    process.on('exit', () => api.close());
  }
  stamped(
    `agentdeck ${once ? 'run-once' : 'daemon'} ${info.commit ? info.commit.slice(0, 7) : 'no commit'} (pid ${info.pid}): ${isPaused(db) && !once ? 'PAUSED (agentdeck resume to start)' : 'active'}, max ${maxConcurrent(db)} concurrent, tick ${DEFAULTS.tickMs / 1000}s`,
  );
  try {
    await scheduler.run();
  } finally {
    changes?.stop();
  }
}
