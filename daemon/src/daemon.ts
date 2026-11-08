// The daemon's composition root: wires the source watcher, the API and the scheduler together and runs until stopped.
// It runs on the App `compose.ts` built (`db` below). It reports through `log` and throws what the caller should
// print; it never prints or exits on its own account.
import { startApi } from './api/server.ts';
import { join } from 'node:path';
import { type ComposedApp, isPaused, maxConcurrent, reloadOnChange } from './application/actions.ts';
import { ChangeWatcher } from './application/operations/changes.ts';
import { reloadBlock } from './application/operations/reload-block.ts';
import { Scheduler } from './application/scheduler/scheduler.ts';
import { API_PORT, DEFAULTS } from './config.ts';
import { type Activity, SCHEMA_DIRTY, offMain, reloadDecision, runOnceRefusal } from './domain/operations/index.ts';

export interface DaemonOptions {
  db: ComposedApp;
  /** Run the queue once and return, without the API, the source watcher or keeping the Mac awake. */
  once: boolean;
  log?: (line: string) => void;
}

export async function runDaemon({ db, once, log = () => {} }: DaemonOptions): Promise<void> {
  // run-once has no API to claim the port, so it asks whether a daemon answers there: only one process runs follow-ups.
  if (once) {
    const refusal = runOnceRefusal(await db.service.daemonState(API_PORT), API_PORT);
    if (refusal) throw new Error(refusal);
  }
  // Read once at start: it names the code this process loaded, even if the checkout moves on later.
  const info = { commit: await db.source.commit(import.meta.dirname), started_at: new Date().toISOString(), pid: process.pid };
  // The lines the scheduler doesn't date itself get the same `[time]` prefix, so the log can say when the daemon started and stopped.
  const stamped = (line: string) => log(`[${new Date().toISOString()}] ${line}`);
  let restartRequested = false;
  const changed: string[] = [];
  let lastChangeAt: number | null = null;
  // Why the code on disk must not be loaded, worked out when a change arrives (null: fine to load).
  const block = reloadBlock(
    async () => {
      const [dirty, branch] = await Promise.all([
        db.source.dirty(join(import.meta.dirname, 'db', 'schema.ts')),
        db.source.branch(import.meta.dirname),
      ]);
      return dirty ? SCHEMA_DIRTY : branch && branch !== 'main' ? offMain(branch) : null;
    },
    // Once per distinct reason: the scheduler only logs pending decisions, and a block is not one.
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
          // A commit changes no file, so look again while blocked.
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
        // launchd's KeepAlive starts the daemon again on the code now on disk.
        exit: () => process.exit(0),
      };
  const scheduler = new Scheduler(db, { once, keepAwake: !once, reload });
  // The CLI writes to the same database from its own process; its writes should reach the scheduler and the dashboard at once.
  const changes = once ? undefined : new ChangeWatcher(db);
  changes?.onOtherProcess(() => scheduler.wake());
  changes?.start();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stamped(`${sig}: stopping workers; their tasks will be requeued on next start`);
      changes?.stop();
      scheduler.stop();
      process.exit(0);
    });
  }
  if (!once) {
    const requestRestart = () => {
      restartRequested = true;
      // After the API has answered: waking may exit the process at once.
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
