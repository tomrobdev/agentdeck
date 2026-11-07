// Tells subscribers when the database changed. The revision it counts is what the dashboard's event stream sends.
// An instance made in daemon.ts, not module state.
import type { Db } from '../../db/index.ts';

export class ChangeWatcher {
  /** Moves by one whenever the database changed, whoever wrote. Starts at 1. */
  rev = 1;
  private readonly subscribers = new Set<(rev: number) => void>();
  private readonly otherProcess = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private last: { dataVersion: number; ownChanges: number };

  private readonly db: Pick<Db, 'changeCounters'>;

  constructor(db: Pick<Db, 'changeCounters'>) {
    this.db = db;
    this.last = db.changeCounters();
  }

  /** Check the counters every `intervalMs` on a timer that does not keep the process alive. */
  start(intervalMs = 250): void {
    this.stop();
    this.last = this.db.changeCounters();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Called with the new revision on every change. Returns the unsubscribe. */
  subscribe(fn: (rev: number) => void): () => void {
    this.subscribers.add(fn);
    return () => void this.subscribers.delete(fn);
  }

  /** Called when another process wrote (not this daemon's own writes). */
  onOtherProcess(fn: () => void): void {
    this.otherProcess.add(fn);
  }

  /** Read the counters once and notify if they moved. */
  check(): void {
    const now = this.db.changeCounters();
    const other = now.dataVersion !== this.last.dataVersion;
    const own = now.ownChanges !== this.last.ownChanges;
    this.last = now;
    if (!other && !own) return;
    this.rev++;
    for (const fn of [...this.subscribers]) fn(this.rev);
    if (other) for (const fn of [...this.otherProcess]) fn();
  }
}
