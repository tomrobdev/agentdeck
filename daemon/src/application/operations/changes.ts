// Tells subscribers when the database changed.
import type { App } from '../ports/app.ts';

export class ChangeWatcher {
  rev = 1;
  private readonly subscribers = new Set<(rev: number) => void>();
  private readonly otherProcess = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private last: { dataVersion: number; ownChanges: number };

  private readonly app: Pick<App, 'changeCounters'>;

  constructor(app: Pick<App, 'changeCounters'>) {
    this.app = app;
    this.last = app.changeCounters();
  }

  start(intervalMs = 250): void {
    this.stop();
    this.last = this.app.changeCounters();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  subscribe(fn: (rev: number) => void): () => void {
    this.subscribers.add(fn);
    return () => void this.subscribers.delete(fn);
  }

  onOtherProcess(fn: () => void): void {
    this.otherProcess.add(fn);
  }

  check(): void {
    const now = this.app.changeCounters();
    const other = now.dataVersion !== this.last.dataVersion;
    const own = now.ownChanges !== this.last.ownChanges;
    this.last = now;
    if (!other && !own) return;
    this.rev++;
    for (const fn of [...this.subscribers]) fn(this.rev);
    if (other) for (const fn of [...this.otherProcess]) fn();
  }
}
