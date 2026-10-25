// The daemon's loop: claims queued tasks into free slots when the governor allows, runs the planner
// when a queue runs dry, and refreshes open PRs.
import { KeepAwake } from '../adapters/caffeinate.ts';
import { activeChildren, killGroup, reapOrphans } from '../adapters/processes.ts';
import { DEFAULTS } from '../config.ts';
import type { Db } from '../db/index.ts';
import { MAX_RESTARTS } from '../domain/task/lifecycle.ts';
import type { Activity, ReloadDecision } from '../domain/daemon/restart.ts';
import { startGate } from './gate.ts';
import { notifyLater } from './notifications.ts';
import { proposeNow, plannerDue } from './planner.ts';
import { resolveConflicting } from './sync.ts';
import { PR_REFRESH_MS, refreshPrStates } from './pull-requests.ts';
import { settle, settleRecovered } from './settle.ts';
import { runTask } from './worker.ts';

/** After a merge, how many times to re-read PRs whose mergeability GitHub is still computing, and how far apart. */
const PR_RECHECKS = 6;
const PR_RECHECK_MS = 20_000;

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
  /** Restart onto new code: `check` says whether that is due, `exit` ends the process once it is. */
  reload?: { check: (activity: Activity) => ReloadDecision; exit: () => void };
  log?: (msg: string) => void;
}

export class Scheduler {
  private readonly db: Db;
  private readonly opts: Required<Omit<SchedulerOptions, 'reload'>>;
  private readonly reload: SchedulerOptions['reload'];
  /** Everything holding a slot: task runs, and the syncs and conflict resolutions in `resolves`. */
  private readonly running = new Set<Promise<unknown>>();
  private readonly resolves = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private drained: (() => void) | undefined;
  private lastHold: string | null = null;
  private lastReload: string | null = null;
  /** Planner runs going: the scheduler's own and the ones people asked for through the API. */
  private proposingRuns = 0;
  private readonly awake: KeepAwake;
  private lastPrRefresh = 0;
  private refreshingPrs = false;
  /** The latest `pr_check_requested` this scheduler has acted on. */
  private handledPrCheck = Date.now();
  private recheckLeft = 0;
  private recheckAt = 0;

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
    this.reload = opts.reload;
    this.awake = new KeepAwake(this.opts.keepAwake);
  }

  /** Start ticking. Resolves when stopped, or when the queue is drained in `once` mode. */
  run(): Promise<void> {
    const reaped = reapOrphans(this.db.unfinishedPids());
    if (reaped) this.opts.log(`stopped ${reaped} claude process(es) left running by a previous daemon`);
    const { requeued, failed } = this.db.recoverOrphans();
    if (requeued) this.opts.log(`requeued ${requeued} task(s) left running by a previous daemon`);
    if (failed.length) this.opts.log(`failed ${failed.length} task(s) interrupted by ${MAX_RESTARTS} daemon restarts`);
    settleRecovered(this.db, failed).catch((err) => this.opts.log(`settling recovered tasks crashed: ${err?.stack ?? err}`));
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

  /**
   * Count a sync or planner run the API started: a sync takes a slot, a proposing run counts as proposing. Either one
   * keeps a reload from exiting until it settles, and ticks when it does. Returns `p` itself so the caller can still await it.
   */
  track<T>(p: Promise<T>, kind: 'sync' | 'propose'): Promise<T> {
    const settled: Promise<unknown> = p
      .catch(() => {})
      .finally(() => {
        if (kind === 'sync') this.releaseResolve(settled);
        else this.proposingRuns--;
        this.tick();
      });
    if (kind === 'sync') this.holdResolve(settled);
    else this.proposingRuns++;
    return p;
  }

  private holdResolve(p: Promise<unknown>): void {
    this.running.add(p);
    this.resolves.add(p);
  }

  private releaseResolve(p: Promise<unknown>): void {
    this.running.delete(p);
    this.resolves.delete(p);
  }

  private get proposing(): boolean {
    return this.proposingRuns > 0;
  }

  /** What is going on that a restart would have to wait for. */
  private get activity(): Activity {
    return { tasks: this.running.size - this.resolves.size, resolves: this.resolves.size, planner: this.proposingRuns };
  }

  private schedule(): void {
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.opts.tickMs);
  }

  private tick(): void {
    if (this.stopped) return;
    const reload = this.reload?.check(this.activity);
    if (reload?.exit) {
      this.opts.log(reload.reason);
      this.stop();
      this.reload!.exit();
      return;
    }
    if (reload?.pending && reload.reason !== this.lastReload) this.opts.log(reload.reason);
    this.lastReload = reload?.pending ? reload.reason : null;
    const { reason, limit } = reload?.pending ? { reason: 'reload pending', limit: 0 } : this.gate();
    if (!reason) {
      while (this.running.size < limit) {
        const task = this.db.claimNextTask();
        if (!task) break;
        this.opts.log(`task ${task.id} attempt ${task.attempts}: starting "${task.title}"`);
        const p = runTask(this.db, task)
          .then((res) => this.opts.log(`task ${task.id}: ${res.outcome}${res.reason ? ` (${res.reason})` : ''}`))
          .catch((err) => {
            this.opts.log(`task ${task.id}: worker crashed: ${err?.stack ?? err}`);
            return settle(
              this.db,
              task.id,
              { type: 'finish', outcome: 'failed', retry: false },
              { reason: String(err?.message ?? err) },
            ).catch((e) => this.opts.log(`task ${task.id}: settling crashed: ${e?.stack ?? e}`));
          })
          .finally(() => {
            this.running.delete(p);
            this.tick(); // a slot opened up
          });
        this.running.add(p);
      }
      if (this.opts.autoPlan && !this.proposing && this.running.size < limit) this.maybePropose();
    }
    this.maybeRefreshPrs();
    this.awake.set(this.running.size > 0 || this.proposing);
    if (this.opts.once && this.running.size === 0 && !this.proposing && (reason || !this.db.hasQueued())) {
      this.stop();
      return;
    }
    clearTimeout(this.timer);
    this.schedule();
  }

  /**
   * Every few minutes (not every tick), re-read the state of open PRs; a merged one releases the tasks waiting on it,
   * and a conflicting one gets the base merged in. A merge from the app or the CLI asks for a re-read at once, and
   * while GitHub is still working out whether the other PRs conflict it is repeated every few seconds.
   */
  private maybeRefreshPrs(): void {
    if (this.opts.once || this.refreshingPrs) return;
    const requested = this.db.prCheckRequested();
    const now = Date.now();
    const due =
      now - this.lastPrRefresh >= this.opts.prRefreshMs ||
      requested > this.handledPrCheck ||
      (this.recheckLeft > 0 && now >= this.recheckAt);
    if (!due) return;
    if (requested > this.handledPrCheck) this.recheckLeft = PR_RECHECKS;
    this.handledPrCheck = Math.max(this.handledPrCheck, requested);
    this.lastPrRefresh = now;
    this.refreshingPrs = true;
    refreshPrStates(this.db, this.opts.log)
      .then((found) => {
        this.recheckLeft = found.unknown ? Math.max(this.recheckLeft - 1, 0) : 0;
        this.recheckAt = Date.now() + PR_RECHECK_MS;
        if (found.conflicting.length) this.resolveConflicts(found.conflicting);
      })
      .catch((err) => this.opts.log(`pr refresh crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.refreshingPrs = false;
      });
  }

  /** Merge the base into conflicting PRs' branches in the background; counts as a running task while it works. */
  private resolveConflicts(ids: number[]): void {
    const p = resolveConflicting(this.db, ids, this.opts.log)
      .catch((err) => this.opts.log(`conflict resolution crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.releaseResolve(p);
        this.tick();
      });
    this.holdResolve(p);
  }

  /** Run the planner for the first repo whose queue has run dry. One planner at a time. */
  private maybePropose(): void {
    const repo = this.db.listRepos().find((r) => plannerDue(this.db, r));
    if (!repo) return;
    this.opts.log(`planner: proposing tasks for ${repo.name}`);
    this.track(
      proposeNow(this.db, repo.id)
        .then((r) => this.opts.log(`planner: ${repo.name}: ${r.outcome}, ${r.tasks.length} task(s)${r.note ? ` (${r.note})` : ''}`))
        .catch((err) => this.opts.log(`planner: ${repo.name} crashed: ${err?.stack ?? err}`)),
      'propose',
    );
  }

  /** Why we can't start new work right now (null if we can), and how many tasks may run. */
  private gate(): { reason: string | null; limit: number } {
    const g = startGate(this.db);
    if (!this.opts.once && g.paused) return { reason: 'paused', limit: 0 };
    const until = g.rate_limited_until;
    if (until && until * 1000 > Date.now())
      return { reason: `rate limited until ${new Date(until * 1000).toLocaleTimeString()}`, limit: 0 };

    const d = g.governor;
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
