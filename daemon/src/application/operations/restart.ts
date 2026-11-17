// Restarting the daemon without losing work: stop claiming, wait for the runs to end, restart, then put pause back.
import type { App } from '#application/ports/app.ts';
import { type Activity, restartWait } from '#domain/operations/index.ts';

export function runningActivity(app: App): Activity {
  return {
    tasks: app.countRunning(),
    planner: app.countRunningPlannerRuns(),
    resolves: app.countRunningResolves(),
    unblocks: app.countRunningUnblocks(),
    reviews: app.countRunningReviews(),
    verifies: app.countRunningVerifies(),
  };
}

export interface RestartDeps {
  restart: () => Promise<unknown>;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  aborted?: () => boolean;
}

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
