// The Processes port: the claude process groups, and keeping the Mac awake while they work.

export interface PidRecord {
  pid: number;
  pid_at: string;
}

export interface KeepAwake {
  set(on: boolean): void;
}

export interface Processes {
  stopAll(): void;
  reapOrphans(runs: PidRecord[], graceMs?: number): number;
  ownsLiveGroup(run: PidRecord): boolean;
  keepAwake(enabled: boolean): KeepAwake;
}
