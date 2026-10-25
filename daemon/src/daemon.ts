// The daemon's composition root: wires the source watcher, the API and the scheduler together and runs until stopped.
// It reports through `log` and throws what the caller should print; it never prints or exits on its own account.
import type { Db } from './db/index.ts';
import { startApi } from './api/server.ts';
import { checkoutCommit } from './adapters/git.ts';
import { watchSource } from './adapters/watch.ts';
import { Scheduler } from './application/scheduler/scheduler.ts';
import { API_PORT, DEFAULTS } from './config.ts';
import { type Activity, reloadDecision } from './domain/daemon/restart.ts';

export interface DaemonOptions {
  db: Db;
  /** Run the queue once and return, without the API, the source watcher or keeping the Mac awake. */
  once: boolean;
  log?: (line: string) => void;
}

export async function runDaemon({ db, once, log = () => {} }: DaemonOptions): Promise<void> {
  // Read once at start: it names the code this process loaded, even if the checkout moves on later.
  const info = { commit: await checkoutCommit(import.meta.dirname), started_at: new Date().toISOString() };
  let restartRequested = false;
  const changed: string[] = [];
  let lastChangeAt: number | null = null;
  if (!once) {
    watchSource(import.meta.dirname, (file) => {
      if (!changed.includes(file)) changed.push(file);
      lastChangeAt = Date.now();
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
          }),
        // launchd's KeepAlive starts the daemon again on the code now on disk.
        exit: () => process.exit(0),
      };
  const scheduler = new Scheduler(db, { once, keepAwake: !once, reload });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log(`${sig}: stopping workers; their tasks will be requeued on next start`);
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
    const api = await startApi({ db, port: API_PORT, scheduler, daemon: { info, requestRestart } }).catch((err) => {
      if (err?.code === 'EADDRINUSE')
        throw new Error(`port ${API_PORT} is in use: another agentdeck daemon is probably running (see \`agentdeck service\`)`);
      throw err;
    });
    log(`api        http://127.0.0.1:${API_PORT}`);
    process.on('exit', () => api.close());
  }
  log(
    `agentdeck ${once ? 'run-once' : 'daemon'}: ${db.isPaused() && !once ? 'PAUSED (agentdeck resume to start)' : 'active'}, max ${db.maxConcurrent()} concurrent, tick ${DEFAULTS.tickMs / 1000}s`,
  );
  await scheduler.run();
}
