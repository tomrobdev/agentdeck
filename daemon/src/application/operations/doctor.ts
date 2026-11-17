// `agentdeck doctor`: gathers the facts about the daemon (launchd, the API, git, the processes of runs, the log, gh) and has domain/operations/health.ts judge them.
import { API_PORT, CHECKOUT_ROOT } from '#src/config.ts';
import type { App } from '#application/ports/app.ts';
import { type Check, type DaemonState, type HealthFacts, judgeHealth, logFacts } from '#domain/operations/index.ts';
import { sqliteMs } from '#domain/shared/index.ts';
import { reviewsDue } from '#application/operations/review-due.ts';

export interface Probes {
  service: () => Promise<HealthFacts['service']>;
  api: (port: number) => Promise<DaemonState | null>;
  head: () => Promise<string | null>;
  ahead: (commit: string) => Promise<number | null>;
  alive: (run: { pid: number; pid_at: string }) => boolean;
  logLines: () => string[] | null;
  gh: () => Promise<HealthFacts['gh']>;
  reviews: () => Promise<HealthFacts['reviews']>;
  now: () => number;
}

export const realProbes = (app: App): Probes => ({
  service: () => app.service.status(),
  api: (port) => app.service.daemonState(port),
  head: async () => (await app.workspace.head(CHECKOUT_ROOT))?.sha ?? null,
  ahead: (commit) => app.workspace.commitsAhead(CHECKOUT_ROOT, commit).catch(() => null),
  alive: (run) => app.processes.ownsLiveGroup(run),
  logLines: () => app.service.logTail(),
  gh: () => app.codeHost.auth(),
  reviews: () => reviewsDue(app),
  now: Date.now,
});

const RUN_DAYS = 7;

export async function gatherHealth(app: App, probes: Probes = realProbes(app), port = API_PORT): Promise<HealthFacts> {
  const [service, api, head, gh, reviews] = await Promise.all([
    probes.service(),
    probes.api(port),
    probes.head(),
    probes.gh(),
    probes.reviews(),
  ]);
  const now = probes.now();
  const behind = api?.commit && head && api.commit !== head ? await probes.ahead(api.commit) : null;
  const processes = app
    .pidRuns(RUN_DAYS)
    .filter((r) => probes.alive(r))
    .map((r) => ({ kind: r.kind, run: r.id, pid: r.pid, ended: r.ended_at !== null }));
  const tasks = app.runningTaskRuns().map((t) => ({
    id: t.id,
    pid: t.pid,
    alive: t.pid !== null && probes.alive({ pid: t.pid, pid_at: t.pid_at ?? '' }),
    runAgeSeconds: t.started_at ? (now - sqliteMs(t.started_at)) / 1000 : null,
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
    reviews,
  };
}

export async function daemonHealth(app: App, probes: Probes = realProbes(app), port?: number): Promise<Check[]> {
  return judgeHealth(await gatherHealth(app, probes, port));
}

export const REPORT_LOG_LINES = 20;

export async function daemonReport(app: App, probes: Probes = realProbes(app), port?: number) {
  const facts = await gatherHealth(app, probes, port);
  const lines = probes.logLines();
  return {
    checks: judgeHealth(facts),
    head: facts.head,
    running: app.runningTasks(),
    log: lines ? lines.filter((l) => l !== '').slice(-REPORT_LOG_LINES) : [],
  };
}

export function restartNow(app: App, restart: () => Promise<unknown>, delayMs = 200) {
  const requeued = app.runningTasks();
  setTimeout(() => void restart().catch(() => {}), delayMs).unref();
  return { requeued };
}
