// Proposals' repository: one row per planner claude process.
import type { PlannerRunId, RepoId } from '#domain/shared/index.ts';
import type { PlannerOutcome, PlannerRun } from '#domain/proposals/index.ts';

export interface PlannerRunRepository {
  startPlannerRun(repo_id: RepoId, log_path: string): PlannerRunId;
  setPlannerRunPid(id: PlannerRunId, pid: number): void;
  finishPlannerRun(id: PlannerRunId, outcome: PlannerOutcome, proposed: number, note: string | null): void;
  countRunningPlannerRuns(): number;
  unfinishedPlannerRuns(): { id: PlannerRunId; repo_id: RepoId; repo: string; started_at: string }[];
  plannerRuns(repo_id?: RepoId, limit?: number): PlannerRun[];
}
