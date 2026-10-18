import { DEFAULTS } from './config.ts';
import type { Db } from './db.ts';
import { decide } from './governor.ts';
import { notifyLater } from './notify.ts';
import { activeChildren, runTask } from './worker.ts';

export interface SchedulerOptions {
  tickMs?: number;
  /** Ignore the paused flag and exit once the queue is drained (for tests and `run-once`). */
  once?: boolean;
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

  constructor(db: Db, opts: SchedulerOptions = {}) {
    this.db = db;
    this.opts = { tickMs: DEFAULTS.tickMs, once: false, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`), ...opts };
  }

  /** Start ticking. Resolves when stopped, or when the queue is drained in `once` mode. */
  run(): Promise<void> {
    const recovered = this.db.recoverOrphans();
    if (recovered) this.opts.log(`requeued ${recovered} task(s) left running by a previous daemon`);
    return new Promise((resolve) => {
      this.drained = resolve;
      this.tick();
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const child of activeChildren) child.kill('SIGTERM');
    this.drained?.();
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
            this.db.updateTask(task.id, { status: 'failed', blocked_reason: String(err?.message ?? err) });
          })
          .finally(() => {
            this.running.delete(p);
            this.tick(); // a slot opened up
          });
        this.running.add(p);
      }
    }
    if (this.opts.once && this.running.size === 0 && (reason || !this.db.listTasks('queued').length)) {
      this.stop();
      return;
    }
    clearTimeout(this.timer);
    this.schedule();
  }

  /** Why we can't start new work right now (null if we can), and how many tasks may run. */
  private gate(): { reason: string | null; limit: number } {
    if (!this.opts.once && this.db.isPaused()) return { reason: 'paused', limit: 0 };
    const until = Number(this.db.getSetting('rate_limited_until', '0'));
    if (until * 1000 > Date.now()) return { reason: `rate limited until ${new Date(until * 1000).toLocaleTimeString()}`, limit: 0 };

    const d = decide(this.db.usageWindows(), this.db.budget(), this.db.maxConcurrent());
    const hold = d.allow ? null : d.reason;
    // Announce a hold once, and only when it is actually keeping queued work waiting.
    if (hold && !this.lastHold && this.db.listTasks('queued').length) {
      const lifts = d.until ? ` Resumes around ${new Date(d.until * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
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
