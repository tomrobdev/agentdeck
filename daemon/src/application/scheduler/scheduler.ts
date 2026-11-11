// The daemon's loop: claims queued tasks into free slots when the governor allows, runs the planner when a queue runs dry, opens again the PRs that failed to open, and refreshes open PRs, merging those that pass the auto-merge check.
import { DEFAULTS } from '#src/config.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { MAX_RESTARTS } from '#domain/work/index.ts';
import { describeWait } from '#domain/work/index.ts';
import { queueWait } from '#application/capacity/gate.ts';
import { notifyLater } from '#application/operations/notifications.ts';
import { REVIEW_CHECK_MS, checkReviewsDue } from '#application/operations/review-due.ts';
import { proposeNow, plannerDue } from '#application/proposals/planner.ts';
import { resolveConflicting } from '#application/runs/sync.ts';
import { autoMerge } from '#application/landing/merge/auto-merge.ts';
import { MERGE_REQUEST_POLL_MS, PR_REFRESH_MS, refreshPrStates } from '#application/landing/pull-request/refresh.ts';
import { followUpPending, hasFollowUpsToRun } from '#application/landing/settle.ts';
import { retryFailedPrs } from '#application/landing/pull-request/open-pr.ts';
import { nextUnblockable } from '#application/runs/unblock.ts';
import { nextReviewable } from '#application/runs/review.ts';
import { startReview, startUnblock, startWork } from '#application/scheduler/start-runs.ts';
import type { App } from '#application/ports/app.ts';
import type { KeepAwake } from '#application/ports/processes.ts';
import type { Activity, ReloadDecision } from '#domain/operations/index.ts';

const REVIEW_LOOK_MS = 30_000;

const PR_RECHECKS = 6;
const PR_RECHECK_MS = 20_000;

export interface SchedulerOptions {
  tickMs?: number;
  once?: boolean;
  autoPropose?: boolean;
  keepAwake?: boolean;
  prRefreshMs?: number;
  reload?: { check: (activity: Activity) => ReloadDecision; exit: () => void };
  log?: (msg: string) => void;
}

export class Scheduler {
  private readonly app: App;
  private readonly opts: Required<Omit<SchedulerOptions, 'reload'>>;
  private readonly reload: SchedulerOptions['reload'];
  private readonly running = new Set<Promise<unknown>>();
  private readonly resolves = new Set<Promise<unknown>>();
  private readonly unblocks = new Set<Promise<unknown>>();
  private readonly reviews = new Set<Promise<unknown>>();
  private readonly verifies = new Set<Promise<unknown>>();
  private findingReview = false;
  private reviewIdleUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private drained: (() => void) | undefined;
  private lastHold: string | null = null;
  private lastReload: string | null = null;
  private proposingRuns = 0;
  private readonly awake: KeepAwake;
  private lastPrRefresh = 0;
  private refreshingPrs = false;
  private lastReviewCheck = 0;
  private checkingReviews = false;
  private followingUp = false;
  private handledPrCheck = Date.now();
  private recheckLeft = 0;
  private recheckAt = 0;
  private requestPollAt = 0;
  private readonly autoMergeErrors = new Map<TaskId, string>();
  private readonly conflictsTold = new Set<TaskId>();

  constructor(app: App, opts: SchedulerOptions = {}) {
    this.app = app;
    this.opts = {
      tickMs: DEFAULTS.tickMs,
      once: false,
      autoPropose: !opts.once,
      keepAwake: false,
      prRefreshMs: PR_REFRESH_MS,
      log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
      ...opts,
    };
    this.reload = opts.reload;
    this.awake = app.processes.keepAwake(this.opts.keepAwake);
  }

  run(): Promise<void> {
    const reaped = this.app.processes.reapOrphans(this.app.unfinishedPids());
    if (reaped) this.opts.log(`stopped ${reaped} claude process(es) left running by a previous daemon`);
    const { requeued, failed } = this.app.recoverOrphans();
    if (requeued) this.opts.log(`requeued ${requeued} task(s) left running by a previous daemon`);
    if (failed.length) this.opts.log(`failed ${failed.length} task(s) interrupted by ${MAX_RESTARTS} daemon restarts`);
    return new Promise((resolve) => {
      this.drained = resolve;
      this.tick();
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.awake.set(false);
    this.app.processes.stopAll();
    this.drained?.();
  }

  wake(): void {
    this.tick();
  }

  track<T>(p: Promise<T>, kind: 'sync' | 'verify' | 'propose'): Promise<T> {
    const settled: Promise<unknown> = p
      .catch(() => {})
      .finally(() => {
        if (kind === 'propose') this.proposingRuns--;
        else this.freeSlot(settled, kind);
        this.tick();
      });
    if (kind === 'propose') this.proposingRuns++;
    else this.takeSlot(settled, kind);
    return p;
  }

  private takeSlot(p: Promise<unknown>, kind: 'sync' | 'verify'): void {
    this.running.add(p);
    (kind === 'sync' ? this.resolves : this.verifies).add(p);
  }

  private freeSlot(p: Promise<unknown>, kind: 'sync' | 'verify'): void {
    this.running.delete(p);
    (kind === 'sync' ? this.resolves : this.verifies).delete(p);
    this.lookForReviews();
  }

  private lookForReviews(): void {
    this.reviewIdleUntil = 0;
  }

  private get proposing(): boolean {
    return this.proposingRuns > 0;
  }

  private get activity(): Activity {
    return {
      tasks: this.running.size - this.resolves.size - this.unblocks.size - this.reviews.size - this.verifies.size,
      resolves: this.resolves.size,
      unblocks: this.unblocks.size,
      reviews: this.reviews.size,
      verifies: this.verifies.size,
      planner: this.proposingRuns,
    };
  }

  private schedule(): void {
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.opts.tickMs);
  }

  private tick(): void {
    if (this.stopped) return;
    const watcher = this.reload;
    const reload = watcher?.check(this.activity);
    if (watcher && reload?.exit) {
      this.opts.log(reload.reason);
      this.stop();
      watcher.exit();
      return;
    }
    if (reload?.pending && reload.reason !== this.lastReload) this.opts.log(reload.reason);
    this.lastReload = reload?.pending ? reload.reason : null;
    const { reason, free } = reload?.pending ? { reason: 'reload pending', free: 0 } : this.gate();
    const followingUp = this.maybeFollowUp();
    if (!reason && !followingUp) {
      for (let room = free; room > 0; room--) {
        const task = this.app.claimNextTask();
        if (!task) break;
        const p: Promise<unknown> = startWork(this.app, task, this.opts.log, () => {
          this.running.delete(p);
          this.lookForReviews();
          this.tick();
        });
        this.running.add(p);
      }
      this.maybeUnblock();
      this.maybeReview();
      if (this.opts.autoPropose && !this.proposing && this.gate().free > 0) this.maybePropose();
    }
    this.maybeRefreshPrs();
    this.maybeCheckReviews();
    this.awake.set(this.running.size > 0 || this.proposing);
    if (
      this.opts.once &&
      this.running.size === 0 &&
      !this.proposing &&
      !this.followingUp &&
      !this.findingReview &&
      (reason || !this.app.hasQueued())
    ) {
      this.stop();
      return;
    }
    clearTimeout(this.timer);
    this.schedule();
  }

  private maybeFollowUp(): boolean {
    if (this.followingUp) return true;
    if (!hasFollowUpsToRun(this.app)) return false;
    this.followingUp = true;
    followUpPending(this.app, this.opts.log)
      .catch((err) => {
        this.opts.log(`follow-ups crashed: ${err?.stack ?? err}`);
        return 0;
      })
      .then((n) => {
        this.followingUp = false;
        if (n > 0) this.tick();
      });
    return true;
  }

  private maybeRefreshPrs(): void {
    if (this.opts.once || this.refreshingPrs) return;
    const requested = this.app.prCheckRequested();
    const now = Date.now();
    const due =
      now - this.lastPrRefresh >= this.opts.prRefreshMs ||
      requested > this.handledPrCheck ||
      (this.recheckLeft > 0 && now >= this.recheckAt) ||
      (this.requestPollAt > 0 && now >= this.requestPollAt);
    if (!due) return;
    if (requested > this.handledPrCheck) this.recheckLeft = PR_RECHECKS;
    this.handledPrCheck = Math.max(this.handledPrCheck, requested);
    this.lastPrRefresh = now;
    this.refreshingPrs = true;
    retryFailedPrs(this.app, this.opts.log)
      .catch((err) => this.opts.log(`PR retry crashed: ${err?.stack ?? err}`))
      .then(() => refreshPrStates(this.app, this.opts.log))
      .then((found) => {
        this.recheckLeft = found.unknown ? Math.max(this.recheckLeft - 1, 0) : 0;
        this.recheckAt = Date.now() + PR_RECHECK_MS;
        this.requestPollAt = found.polling ? Date.now() + MERGE_REQUEST_POLL_MS : 0;
        if (found.conflicting.length) this.resolveConflicts(found.conflicting);
        if (!found.mergeable.length) return undefined;
        return autoMerge(this.app, found.mergeable, { log: this.opts.log, told: this.autoMergeErrors }).then((merged) => {
          if (merged) this.tick();
        });
      })
      .catch((err) => this.opts.log(`pr refresh crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.refreshingPrs = false;
      });
  }

  private maybeCheckReviews(): void {
    const now = Date.now();
    if (this.opts.once || this.checkingReviews || now - this.lastReviewCheck < REVIEW_CHECK_MS) return;
    this.lastReviewCheck = now;
    this.checkingReviews = true;
    checkReviewsDue(this.app, now)
      .catch((err) => this.opts.log(`area review check crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.checkingReviews = false;
      });
  }

  private resolveConflicts(ids: TaskId[]): void {
    const p = resolveConflicting(this.app, ids, this.opts.log, this.conflictsTold)
      .catch((err) => this.opts.log(`conflict resolution crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.freeSlot(p, 'sync');
        this.tick();
      });
    this.takeSlot(p, 'sync');
  }

  private maybeUnblock(): void {
    for (let room = this.gate().free; room > 0; room--) {
      const task = nextUnblockable(this.app);
      if (!task) return;
      const p: Promise<unknown> = startUnblock(this.app, task, this.opts.log, () => {
        this.running.delete(p);
        this.unblocks.delete(p);
        this.lookForReviews();
        this.tick();
      });
      this.running.add(p);
      this.unblocks.add(p);
    }
  }

  private maybeReview(): void {
    if (this.findingReview || Date.now() < this.reviewIdleUntil || this.gate().free <= 0) return;
    this.findingReview = true;
    nextReviewable(this.app)
      .then((target) => {
        this.findingReview = false;
        if (!target) this.reviewIdleUntil = Date.now() + REVIEW_LOOK_MS;
        if (!target || this.stopped) return;
        const { reason, free } = this.gate();
        if (reason || free <= 0) return;
        const p: Promise<unknown> = startReview(this.app, target, this.opts.log, () => {
          this.running.delete(p);
          this.reviews.delete(p);
          this.lookForReviews();
          this.tick();
        });
        this.running.add(p);
        this.reviews.add(p);
        this.tick();
      })
      .catch((err) => {
        this.findingReview = false;
        this.reviewIdleUntil = Date.now() + REVIEW_LOOK_MS;
        this.opts.log(`review runs: looking for one crashed: ${err?.stack ?? err}`);
      });
  }

  private maybePropose(): void {
    const repo = this.app.listRepos().find((r) => plannerDue(this.app, r));
    if (!repo) return;
    this.opts.log(`planner: proposing tasks for ${repo.name}`);
    this.track(
      proposeNow(this.app, repo.id)
        .then((r) => this.opts.log(`planner: ${repo.name}: ${r.outcome}, ${r.tasks.length} task(s)${r.note ? ` (${r.note})` : ''}`))
        .catch((err) => this.opts.log(`planner: ${repo.name} crashed: ${err?.stack ?? err}`)),
      'propose',
    );
  }

  private gate(): { reason: string | null; free: number } {
    const { wait, free } = queueWait(this.app, this.opts.once);
    const hold = wait?.kind === 'governor' ? wait : null;
    if (hold && !this.lastHold && this.app.hasQueued()) {
      const lifts = hold.until
        ? ` Resumes around ${new Date(hold.until * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
        : '';
      this.opts.log(`governor hold: ${hold.reason}`);
      notifyLater(this.app, { kind: 'hold', title: 'Queued work on hold', body: `${hold.reason}.${lifts}` });
      this.lastHold = hold.reason;
    } else if (!wait && this.lastHold) {
      this.opts.log('governor: hold lifted');
      this.lastHold = null;
    }
    return { reason: wait ? describeWait(wait) : null, free };
  }
}
