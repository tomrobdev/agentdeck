import { DEFAULTS } from './config.ts';
import type { Db } from './db.ts';
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
    const reason = this.holdReason();
    if (!reason) {
      while (this.running.size < this.db.maxConcurrent()) {
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

  /** Why we are not starting new work right now, or null if we can. */
  private holdReason(): string | null {
    if (!this.opts.once && this.db.isPaused()) return 'paused';
    const until = Number(this.db.getSetting('rate_limited_until', '0'));
    if (until * 1000 > Date.now()) return `rate limited until ${new Date(until * 1000).toLocaleTimeString()}`;
    return null;
  }
}
