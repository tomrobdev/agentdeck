// `agentdeck doctor`: gathers the facts about the daemon (launchd, the API, git, the processes of runs, the log, gh) and
// has domain/daemon/health.ts judge them. It runs in the CLI's own process, so it works with the daemon down.
import { fetchDaemonState } from '../../adapters/daemon-api.ts';
import { readLogTail } from '../../adapters/daemon-log.ts';
import { checkoutCommit, commitsAheadOf } from '../../adapters/git.ts';
import { ghAuth } from '../../adapters/github.ts';
import { ownsLiveGroup } from '../../adapters/processes.ts';
import { DAEMON_LOG, serviceStatus } from '../../adapters/service.ts';
import { API_PORT, CHECKOUT_ROOT } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { type Check, type DaemonState, type HealthFacts, judgeHealth, logFacts } from '../../domain/daemon/health.ts';

/** Where the facts come from; tests hand in plain ones. */
export interface Probes {
  service: () => Promise<HealthFacts['service']>;
  api: (port: number) => Promise<DaemonState | null>;
  head: () => Promise<string | null>;
  /** Commits the checkout's HEAD has that `commit` does not. */
  ahead: (commit: string) => Promise<number | null>;
  /** Whether the run's process group is alive and its own. */
  alive: (run: { pid: number; pid_at: string }) => boolean;
  logLines: () => string[] | null;
  gh: () => Promise<HealthFacts['gh']>;
  now: () => number;
}

export const realProbes: Probes = {
  service: serviceStatus,
  api: fetchDaemonState,
  head: () => checkoutCommit(CHECKOUT_ROOT),
  ahead: (commit) => commitsAheadOf(CHECKOUT_ROOT, commit),
  alive: ownsLiveGroup,
  logLines: () => readLogTail(DAEMON_LOG),
  gh: ghAuth,
  now: Date.now,
};

/** How far back ended runs are searched for a claude process that outlived them. */
const RUN_DAYS = 7;
const sqlTime = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

export async function gatherHealth(db: Db, probes: Probes = realProbes, port = API_PORT): Promise<HealthFacts> {
  const [service, api, head, gh] = await Promise.all([probes.service(), probes.api(port), probes.head(), probes.gh()]);
  const now = probes.now();
  const behind = api?.commit && head && api.commit !== head ? await probes.ahead(api.commit) : null;
  const processes = db
    .pidRuns(RUN_DAYS)
    .filter((r) => probes.alive(r))
    .map((r) => ({ kind: r.kind, run: r.id, pid: r.pid, ended: r.ended_at !== null }));
  const tasks = db.runningTaskRuns().map((t) => ({
    id: t.id,
    pid: t.pid,
    alive: t.pid !== null && probes.alive({ pid: t.pid, pid_at: t.pid_at ?? '' }),
    runAgeSeconds: t.started_at ? (now - sqlTime(t.started_at)) / 1000 : null,
  }));
  const lines = probes.logLines();
  return {
    now,
    service,
    port,
    api,
    head,
    behind,
    checkout: CHECKOUT_ROOT,
    processes,
    tasks,
    log: lines ? logFacts(lines, now) : null,
    gh,
  };
}

/** Every check on the daemon's health, with the command that fixes each one that fails. */
export async function daemonHealth(db: Db, probes: Probes = realProbes, port?: number): Promise<Check[]> {
  return judgeHealth(await gatherHealth(db, probes, port));
}

/** Lines of the daemon log in the report. */
export const REPORT_LOG_LINES = 20;

/** GET /api/daemon/health: the doctor's checks, the checkout's HEAD, what is running, and the end of the log. */
export async function daemonReport(db: Db, probes: Probes = realProbes, port?: number) {
  const facts = await gatherHealth(db, probes, port);
  const lines = probes.logLines();
  return {
    checks: judgeHealth(facts),
    head: facts.head,
    running: db.runningTasks(),
    log: lines ? lines.filter((l) => l !== '').slice(-REPORT_LOG_LINES) : [],
  };
}

/**
 * Restart the service at once (POST /api/daemon/restart-now): running tasks lose their run and are requeued.
 * The restart starts after the API has answered, because it kills this process.
 */
export function restartNow(db: Db, restart: () => Promise<unknown>, delayMs = 200) {
  const requeued = db.runningTasks();
  setTimeout(() => void restart().catch(() => {}), delayMs).unref();
  return { requeued };
}
