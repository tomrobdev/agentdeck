// The daemon's loop: claims queued tasks into free slots when the governor allows, runs the planner
// when a queue runs dry, and refreshes open PRs.
import { KeepAwake } from '../adapters/caffeinate.ts';
import { activeChildren, killGroup, reapOrphans } from '../adapters/processes.ts';
import { DEFAULTS } from '../config.ts';
import type { Db } from '../db/index.ts';
import { MAX_RESTARTS } from '../domain/task/lifecycle.ts';
import { decide } from '../domain/usage/governor.ts';
import { warnStuckDependents } from './dependencies.ts';
import { notifyLater } from './notifications.ts';
import { planNow, plannerDue } from './planner.ts';
import { PR_REFRESH_MS, refreshPrStates } from './pull-requests.ts';
import { runTask } from './worker.ts';

export interface SchedulerOptions {
  tickMs?: number;
  /** Ignore the paused flag and exit once the queue is drained (for tests and `run-once`). */
  once?: boolean;
  /** Propose new tasks from repo goals when a queue runs dry (off in once mode by default). */
  autoPlan?: boolean;
  /** Hold a `caffeinate -i` assertion while work is running (macOS). */
  keepAwake?: boolean;
  /** How often to refresh the state of open PRs (off in once mode). */
  prRefreshMs?: number;
  log?: (msg: string) => void;
}

export class Scheduler {
  private readonly db: Db;
  private readonly opts: Required<SchedulerOptions>;
  private readonly running = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private drained: (() => void) | undefined;
  private lastHold: string | null = null;
  private planning = false;
  private readonly awake: KeepAwake;
  private lastPrRefresh = 0;
  private refreshingPrs = false;

  constructor(db: Db, opts: SchedulerOptions = {}) {
    this.db = db;
    this.opts = {
      tickMs: DEFAULTS.tickMs,
      once: false,
      autoPlan: !opts.once,
      keepAwake: false,
      prRefreshMs: PR_REFRESH_MS,
      log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
      ...opts,
    };
    this.awake = new KeepAwake(this.opts.keepAwake);
  }

  /** Start ticking. Resolves when stopped, or when the queue is drained in `once` mode. */
  run(): Promise<void> {
    const reaped = reapOrphans(this.db.unfinishedPids());
    if (reaped) this.opts.log(`stopped ${reaped} claude process(es) left running by a previous daemon`);
    const { requeued, failed } = this.db.recoverOrphans();
    if (requeued) this.opts.log(`requeued ${requeued} task(s) left running by a previous daemon`);
    if (failed.length) this.opts.log(`failed ${failed.length} task(s) interrupted by ${MAX_RESTARTS} daemon restarts`);
    for (const id of failed) warnStuckDependents(this.db, id);
    return new Promise((resolve) => {
      this.drained = resolve;
      this.tick();
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.awake.set(false);
    for (const child of activeChildren) killGroup(child.pid);
    this.drained?.();
  }

  /** Check the queue now instead of at the next tick, after something changed that may let a task start. */
  wake(): void {
    this.tick();
  }

  private schedule(): void {
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.opts.tickMs);
  }

  private tick(): void {
    if (this.stopped) return;
    const { reason, limit } = this.gate();
    if (!reason) {
      while (this.running.size < limit) {
        const task = this.db.claimNextTask();
        if (!task) break;
        this.opts.log(`task ${task.id} attempt ${task.attempts}: starting "${task.title}"`);
        const p = runTask(this.db, task)
          .then((res) => this.opts.log(`task ${task.id}: ${res.outcome}${res.reason ? ` (${res.reason})` : ''}`))
          .catch((err) => {
            this.opts.log(`task ${task.id}: worker crashed: ${err?.stack ?? err}`);
            this.db.applyEvent(task.id, { type: 'finish', outcome: 'failed', retry: false }, { reason: String(err?.message ?? err) });
          })
          .finally(() => {
            this.running.delete(p);
            this.tick(); // a slot opened up
          });
        this.running.add(p);
      }
      if (this.opts.autoPlan && !this.planning && this.running.size < limit) this.maybePlan();
    }
    this.maybeRefreshPrs();
    this.awake.set(this.running.size > 0 || this.planning);
    if (this.opts.once && this.running.size === 0 && !this.planning && (reason || !this.db.hasQueued())) {
      this.stop();
      return;
    }
    clearTimeout(this.timer);
    this.schedule();
  }

  /** Every few minutes (not every tick), re-read the state of open PRs; a merged one releases the tasks waiting on it. */
  private maybeRefreshPrs(): void {
    if (this.opts.once || this.refreshingPrs || Date.now() - this.lastPrRefresh < this.opts.prRefreshMs) return;
    this.lastPrRefresh = Date.now();
    this.refreshingPrs = true;
    refreshPrStates(this.db, this.opts.log)
      .catch((err) => this.opts.log(`pr refresh crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.refreshingPrs = false;
      });
  }

  /** Run the planner for the first repo whose queue has run dry. One planner at a time. */
  private maybePlan(): void {
    const repo = this.db.listRepos().find((r) => plannerDue(this.db, r));
    if (!repo) return;
    this.planning = true;
    this.opts.log(`planner: planning ${repo.name}`);
    planNow(this.db, repo.id)
      .then((r) => this.opts.log(`planner: ${repo.name}: ${r.outcome}, ${r.tasks.length} task(s)${r.note ? ` (${r.note})` : ''}`))
      .catch((err) => this.opts.log(`planner: ${repo.name} crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.planning = false;
        this.tick();
      });
  }

  /** Why we can't start new work right now (null if we can), and how many tasks may run. */
  private gate(): { reason: string | null; limit: number } {
    if (!this.opts.once && this.db.isPaused()) return { reason: 'paused', limit: 0 };
    const until = Number(this.db.getSetting('rate_limited_until', '0'));
    if (until * 1000 > Date.now()) return { reason: `rate limited until ${new Date(until * 1000).toLocaleTimeString()}`, limit: 0 };

    const d = decide(this.db.usageWindows(), this.db.budget(), this.db.maxConcurrent());
    const hold = d.allow ? null : d.reason;
    // Announce a hold once, and only when it is actually keeping queued work waiting.
    if (hold && !this.lastHold && this.db.hasQueued()) {
      const lifts = d.until
        ? ` Resumes around ${new Date(d.until * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
        : '';
      this.opts.log(`governor hold: ${hold}`);
      notifyLater(this.db, { kind: 'hold', title: 'Holding queued work', body: `${hold}.${lifts}` });
      this.lastHold = hold;
    } else if (!hold && this.lastHold) {
      this.opts.log('governor: hold lifted');
      this.lastHold = null;
    }
    return { reason: hold, limit: d.max_concurrent };
  }
}
