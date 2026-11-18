// Capacity's repositories: the usage windows Claude reports and their history, and what a drain still waits for.
import type { TaskId } from '#domain/shared/index.ts';
import type { RepoId } from '#domain/shared/index.ts';

export interface UsageRepository {
  recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void;
  usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[];
  usageSamples(window?: string): { window: string; utilization: number; resets_at: number; observed_at: string }[];
}

export interface DrainRepository {
  inFlightCounts(repo: RepoId | null): { runs: number; retries: number; planner: number };
  queuedThatRan(): Set<TaskId>;
}
