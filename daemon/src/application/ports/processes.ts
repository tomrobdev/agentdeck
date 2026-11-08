// The Processes port: the claude process groups, and keeping the Mac awake while they work. The real adapters are
// adapters/processes.ts and adapters/caffeinate.ts (compose.ts).

/** A claude process group recorded on a run, and when it was recorded (UTC, SQLite format). */
export interface PidRecord {
  pid: number;
  pid_at: string;
}

/** Keeps the Mac from idle-sleeping while on. */
export interface KeepAwake {
  set(on: boolean): void;
}

export interface Processes {
  /** Stop every live claude process, with what it started. */
  stopAll(): void;
  /** Stop the process groups of runs a dead daemon left behind. How many it stopped. */
  reapOrphans(runs: PidRecord[], graceMs?: number): number;
  /** Whether the run's recorded process group is alive and is the run's own, not a pid something else reuses. */
  ownsLiveGroup(run: PidRecord): boolean;
  /** A keep-awake assertion; a no-op unless `enabled` and on a Mac. */
  keepAwake(enabled: boolean): KeepAwake;
}
