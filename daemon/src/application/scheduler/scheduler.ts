// The daemon's loop: claims queued tasks into free slots when the governor allows, runs the planner
// when a queue runs dry, opens again the PRs that failed to open, and refreshes open PRs, merging those that pass the
// auto-merge check.
import { DEFAULTS } from '../../config.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { MAX_RESTARTS } from '../../domain/work/index.ts';
import { describeWait } from '../../domain/work/index.ts';
import { queueWait } from '../capacity/gate.ts';
import { notifyLater } from '../operations/notifications.ts';
import { REVIEW_CHECK_MS, checkReviewsDue } from '../operations/review-due.ts';
import { proposeNow, plannerDue } from '../proposals/planner.ts';
import { resolveConflicting } from '../runs/sync.ts';
import { autoMerge } from '../landing/auto-merge.ts';
import { MERGE_REQUEST_POLL_MS, PR_REFRESH_MS, refreshPrStates } from '../landing/refresh.ts';
import { followUpPending, hasFollowUpsToRun, settle } from '../landing/settle.ts';
import { retryFailedPrs } from '../landing/open-pr.ts';
import { runTask } from '../runs/worker.ts';
import { nextUnblockable, runUnblock } from '../runs/unblock.ts';
import { nextReviewable, runReview } from '../runs/review.ts';
import type { App } from '../ports/app.ts';
import type { KeepAwake } from '../ports/processes.ts';
import type { Activity, ReloadDecision } from '../../domain/operations/index.ts';

/** After a look for a task to review found none, how long until the next, unless a run ends first. */
const REVIEW_LOOK_MS = 30_000;

/** After a merge, how many times to re-read PRs whose mergeability GitHub is still computing, and how far apart. */
const PR_RECHECKS = 6;
const PR_RECHECK_MS = 20_000;

export interface SchedulerOptions {
  tickMs?: number;
  /** Ignore the paused flag and exit once the queue is drained (for tests and `run-once`). */
  once?: boolean;
  /** Propose new tasks from repo goals when a queue runs dry (off in once mode by default). */
  autoPropose?: boolean;
  /** Hold a `caffeinate -i` assertion while work is running (macOS). */
  keepAwake?: boolean;
  /** How often to refresh the state of open PRs (off in once mode). */
  prRefreshMs?: number;
  /** Restart onto new code: `check` says whether that is due, `exit` ends the process once it is. */
  reload?: { check: (activity: Activity) => ReloadDecision; exit: () => void };
  log?: (msg: string) => void;
}

export class Scheduler {
  private readonly app: App;
  private readonly opts: Required<Omit<SchedulerOptions, 'reload'>>;
  private readonly reload: SchedulerOptions['reload'];
  /**
   * Everything that takes a slot: task runs, the syncs and conflict resolutions in `resolves`, the unblock runs in
   * `unblocks` and the review runs in `reviews`.
   */
  private readonly running = new Set<Promise<unknown>>();
  private readonly resolves = new Set<Promise<unknown>>();
  private readonly unblocks = new Set<Promise<unknown>>();
  private readonly reviews = new Set<Promise<unknown>>();
  /** Looking for the next done task to review (`nextReviewable` reads git); one look at a time. */
  private findingReview = false;
  /** After a look found nothing, when to look again; a run that ends looks at once (`lookForReviews`). */
  private reviewIdleUntil = 0;
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
  private lastReviewCheck = 0;
  private checkingReviews = false;
  /** Running the follow-ups pending in the outbox; one pass at a time. */
  private followingUp = false;
  /** The latest `pr_check_requested` this scheduler has acted on. */
  private handledPrCheck = Date.now();
  private recheckLeft = 0;
  private recheckAt = 0;
  /** When to read the PRs again for a merge request waiting on running checks or on mergeability; 0 when none does. */
  private requestPollAt = 0;
  /** The last auto-merge error told for each task, so a merge that keeps failing is told once, not every refresh. */
  private readonly autoMergeErrors = new Map<TaskId, string>();
  /** The tasks whose conflict was told as waiting for a person's sync (auto_resolve off), so it is said once. */
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

  /** Start ticking. Resolves when stopped, or when the queue is drained in `once` mode. */
  run(): Promise<void> {
    const reaped = this.app.processes.reapOrphans(this.app.unfinishedPids());
    if (reaped) this.opts.log(`stopped ${reaped} claude process(es) left running by a previous daemon`);
    // Recovery's status changes wait in the outbox, with any a crash left unfollowed: the first tick runs them.
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
        if (kind === 'sync') this.freeSyncSlot(settled);
        else this.proposingRuns--;
        this.tick();
      });
    if (kind === 'sync') this.takeSyncSlot(settled);
    else this.proposingRuns++;
    return p;
  }

  private takeSyncSlot(p: Promise<unknown>): void {
    this.running.add(p);
    this.resolves.add(p);
  }

  private freeSyncSlot(p: Promise<unknown>): void {
    this.running.delete(p);
    this.resolves.delete(p);
    this.lookForReviews();
  }

  /** A run ended, so a task may have new changes to review: the next tick looks, however recent the last look. */
  private lookForReviews(): void {
    this.reviewIdleUntil = 0;
  }

  private get proposing(): boolean {
    return this.proposingRuns > 0;
  }

  /** What is going on that a restart would have to wait for. */
  private get activity(): Activity {
    return {
      tasks: this.running.size - this.resolves.size - this.unblocks.size - this.reviews.size,
      resolves: this.resolves.size,
      unblocks: this.unblocks.size,
      reviews: this.reviews.size,
      planner: this.proposingRuns,
    };
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
    const { reason, free } = reload?.pending ? { reason: 'reload pending', free: 0 } : this.gate();
    // Follow-ups first: one a crash or a person left pending (a PR to open, say) may change what a claim may take.
    const followingUp = this.maybeFollowUp();
    if (!reason && !followingUp) {
      for (let room = free; room > 0; room--) {
        const task = this.app.claimNextTask();
        if (!task) break;
        this.opts.log(`task ${task.id} attempt ${task.attempts}: starting "${task.title}"`);
        const p = runTask(this.app, task)
          .then((res) => this.opts.log(`task ${task.id}: ${res.outcome}${res.reason ? ` (${res.reason})` : ''}`))
          .catch((err) => {
            this.opts.log(`task ${task.id}: worker crashed: ${err?.stack ?? err}`);
            return settle(
              this.app,
              task.id,
              { type: 'finish', outcome: 'failed', retry: false },
              { reason: String(err?.message ?? err) },
            ).catch((e) => this.opts.log(`task ${task.id}: settling crashed: ${e?.stack ?? e}`));
          })
          .finally(() => {
            this.running.delete(p);
            this.lookForReviews();
            this.tick(); // a slot opened up
          });
        this.running.add(p);
      }
      this.maybeUnblock(); // after the claims: queued work comes first
      this.maybeReview();
      if (this.opts.autoPropose && !this.proposing && this.gate().free > 0) this.maybePropose(); // a claim above took a slot: ask again
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

  /**
   * Run the follow-ups the outbox keeps: a status change's whose follow-ups a crash cut off, recovery's, and a person's
   * from the CLI or the API. Returns whether a pass is running, so the tick claims nothing until it ends; it ticks again
   * when a pass ran some, to claim then (and in once mode to stop only after them).
   */
  private maybeFollowUp(): boolean {
    if (this.followingUp) return true;
    // Rows a settle in this process is following up are left to it, and its run's end ticks.
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

  /**
   * Every few minutes (not every tick), re-read the state of open PRs; a merged one releases the tasks waiting on it,
   * and a conflicting one gets the base merged in. A merge from the app or the CLI asks for a re-read at once, and
   * while GitHub is still working out whether the other PRs conflict it is repeated every few seconds. PRs that pass the
   * auto-merge check are merged before the refresh counts as finished, so two refreshes never merge at once.
   */
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
    // A PR that failed to open is opened again first, so the refresh reads it with the others.
    retryFailedPrs(this.app, this.opts.log)
      .catch((err) => this.opts.log(`PR retry crashed: ${err?.stack ?? err}`))
      .then(() => refreshPrStates(this.app, this.opts.log))
      .then((found) => {
        this.recheckLeft = found.unknown ? Math.max(this.recheckLeft - 1, 0) : 0;
        this.recheckAt = Date.now() + PR_RECHECK_MS;
        // A merge request waiting on checks is read again soon, not after the usual few minutes.
        this.requestPollAt = found.polling ? Date.now() + MERGE_REQUEST_POLL_MS : 0;
        if (found.conflicting.length) this.resolveConflicts(found.conflicting);
        if (found.mergeable.length)
          return autoMerge(this.app, found.mergeable, { log: this.opts.log, told: this.autoMergeErrors }).then((merged) => {
            if (merged) this.tick(); // the tasks waiting on it can start now
          });
      })
      .catch((err) => this.opts.log(`pr refresh crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.refreshingPrs = false;
      });
  }

  /**
   * Once a minute (not in once mode), read the repos' area review marks: store which repos are due for the headline and
   * remind a person of each at most once a day. A moved mark clears its repo on the next check. One check at a time.
   */
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

  /** Merge the base into conflicting PRs' branches in the background; counts as a running task while it works. */
  private resolveConflicts(ids: TaskId[]): void {
    const p = resolveConflicting(this.app, ids, this.opts.log, this.conflictsTold)
      .catch((err) => this.opts.log(`conflict resolution crashed: ${err?.stack ?? err}`))
      .finally(() => {
        this.freeSyncSlot(p);
        this.tick();
      });
    this.takeSyncSlot(p);
  }

  /**
   * Start unblock runs for blocked tasks whose repo has auto_unblock on (`nextUnblockable`), as far as the free slots go.
   * Each takes a slot until it ends, and ticks when it does: a retried task can be claimed at once.
   */
  private maybeUnblock(): void {
    for (let room = this.gate().free; room > 0; room--) {
      const task = nextUnblockable(this.app);
      if (!task) return;
      this.opts.log(`task ${task.id}: unblock run: reading why it blocked`);
      const p: Promise<unknown> = runUnblock(this.app, task)
        .then((r) => this.opts.log(`task ${task.id}: unblock run: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`))
        .catch((err) => this.opts.log(`task ${task.id}: unblock run crashed: ${err?.stack ?? err}`))
        .finally(() => {
          this.running.delete(p);
          this.unblocks.delete(p);
          this.lookForReviews();
          this.tick();
        });
      this.running.add(p);
      this.unblocks.add(p);
    }
  }

  /**
   * Start a review run for a done task with an open PR, in a repo with auto_review on, whose changes had none yet
   * (`nextReviewable`), when a slot is free. One look at a time, since working out the changes reads git; the run row
   * opens before the next look, so the same changes never get two. It takes a slot until it ends, and ticks when it
   * does; a start ticks too, to look for another.
   */
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
        const id = target.task.id;
        this.opts.log(`task ${id}: review run: reading its changes`);
        const p: Promise<unknown> = runReview(this.app, target)
          .then((r) => this.opts.log(`task ${id}: review run: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`))
          .catch((err) => this.opts.log(`task ${id}: review run crashed: ${err?.stack ?? err}`))
          .finally(() => {
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

  /** Run the planner for the first repo whose queue has run dry. One planner at a time. */
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

  /** Why we can't start new work right now (null if we can), and how many slots are free. Announces a hold once. */
  private gate(): { reason: string | null; free: number } {
    const { wait, free } = queueWait(this.app, this.opts.once);
    const hold = wait?.kind === 'governor' ? wait : null;
    // Announce a hold once, and only when it is actually keeping queued work waiting.
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
