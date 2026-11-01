// The daemon's composition root: wires the source watcher, the API and the scheduler together and runs until stopped.
// It reports through `log` and throws what the caller should print; it never prints or exits on its own account.
import type { Db } from './db/index.ts';
import { startApi } from './api/server.ts';
import { join } from 'node:path';
import { checkedOutBranch, checkoutCommit, hasUncommittedChanges } from './adapters/git.ts';
import { watchSource } from './adapters/watch.ts';
import { ChangeWatcher } from './application/changes.ts';
import { Scheduler } from './application/scheduler/scheduler.ts';
import { API_PORT, DEFAULTS } from './config.ts';
import { type Activity, SCHEMA_DIRTY, offMain, reloadDecision } from './domain/daemon/restart.ts';

export interface DaemonOptions {
  db: Db;
  /** Run the queue once and return, without the API, the source watcher or keeping the Mac awake. */
  once: boolean;
  log?: (line: string) => void;
}

export async function runDaemon({ db, once, log = () => {} }: DaemonOptions): Promise<void> {
  // Read once at start: it names the code this process loaded, even if the checkout moves on later.
  const info = { commit: await checkoutCommit(import.meta.dirname), started_at: new Date().toISOString(), pid: process.pid };
  // The lines the scheduler doesn't date itself get the same `[time]` prefix, so the log can say when the daemon started and stopped.
  const stamped = (line: string) => log(`[${new Date().toISOString()}] ${line}`);
  let restartRequested = false;
  const changed: string[] = [];
  let lastChangeAt: number | null = null;
  // Why the code on disk must not be loaded, worked out when a change arrives (null: fine to load).
  let blocked: string | null = null;
  const refreshBlocked = async () => {
    const [dirty, branch] = await Promise.all([
      hasUncommittedChanges(join(import.meta.dirname, 'db', 'schema.ts')),
      checkedOutBranch(import.meta.dirname),
    ]);
    const next = dirty ? SCHEMA_DIRTY : branch && branch !== 'main' ? offMain(branch) : null;
    // Once per distinct reason: the scheduler only logs pending decisions, and a block is not one.
    if (next && next !== blocked) log(`not reloading: ${next}`);
    blocked = next;
  };
  if (!once) {
    watchSource(import.meta.dirname, (file) => {
      if (!changed.includes(file)) changed.push(file);
      lastChangeAt = Date.now();
      void refreshBlocked();
    });
  }
  const reload = once
    ? undefined
    : {
        check: (activity: Activity) =>
          reloadDecision({
            enabled: db.reloadOnChange(),
            changed,
            lastChangeAt,
            now: Date.now(),
            activity,
            requested: restartRequested,
            blocked,
          }),
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
    const reloadFacts = () => ({ changed, lastChangeAt, requested: restartRequested, blocked });
    const api = await startApi({ db, port: API_PORT, scheduler, changes, daemon: { info, requestRestart, reloadFacts } }).catch((err) => {
      if (err?.code === 'EADDRINUSE')
        throw new Error(`port ${API_PORT} is in use: another agentdeck daemon is probably running (see \`agentdeck service\`)`);
      throw err;
    });
    stamped(`api        http://127.0.0.1:${API_PORT}`);
    process.on('exit', () => api.close());
  }
  stamped(
    `agentdeck ${once ? 'run-once' : 'daemon'} ${info.commit ? info.commit.slice(0, 7) : 'no commit'} (pid ${info.pid}): ${db.isPaused() && !once ? 'PAUSED (agentdeck resume to start)' : 'active'}, max ${db.maxConcurrent()} concurrent, tick ${DEFAULTS.tickMs / 1000}s`,
  );
  try {
    await scheduler.run();
  } finally {
    changes?.stop();
  }
}
