// Restarting the daemon without losing work: stop claiming, wait for the runs to end, restart, then put pause back.
import type { App } from '../ports/app.ts';
import { type Activity, restartWait } from '../../domain/operations/index.ts';

/** What the daemon is running now: tasks, planner runs and resolve runs. */
export function runningActivity(app: App): Activity {
  return {
    tasks: app.countRunning(),
    planner: app.countRunningPlannerRuns(),
    resolves: app.countRunningResolves(),
    unblocks: app.countRunningUnblocks(),
  };
}

export interface RestartDeps {
  /** Restart the launchd service. */
  restart: () => Promise<unknown>;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Return true to give up waiting (for example after Ctrl-C). */
  aborted?: () => boolean;
}

/**
 * Pause new claims, wait until no task or planner run is active (twice in a row, so a claim in flight
 * is seen), restart, then restore the pause state from before. The pause state is restored even when
 * the restart fails or the wait is abandoned.
 */
export async function gracefulRestart(app: App, deps: RestartDeps): Promise<{ waited: boolean }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 2000;
  const wasPaused = app.isPaused();
  app.setPaused(true);
  let waited = false;
  try {
    let idle = 0;
    let last: string | null = null;
    while (idle < 2) {
      if (deps.aborted?.()) throw new Error('interrupted; nothing was restarted');
      const wait = restartWait(runningActivity(app));
      if (!wait) {
        idle++;
      } else {
        idle = 0;
        waited = true;
        if (wait !== last) deps.log(`waiting for ${wait} to finish (new work is paused)`);
        last = wait;
      }
      if (idle < 2) await sleep(wait ? pollMs : Math.min(pollMs, 250));
    }
    deps.log('nothing is running; restarting');
    await deps.restart();
  } finally {
    app.setPaused(wasPaused);
  }
  return { waited };
}
