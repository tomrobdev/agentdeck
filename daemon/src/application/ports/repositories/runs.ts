// Runs' repository: one row per claude process of a task.
import type { TaskId } from '#domain/shared/index.ts';
import type { PidRun, Run, RunKind, RunningTaskRun } from '#domain/runs/index.ts';

export interface RunRepository {
  startRun(task_id: TaskId, attempt: number, log_path: string, kind?: RunKind, model?: string | null, diff_hash?: string | null): Run['id'];
  setRunModelId(id: Run['id'], model_id: string): void;
  setRunPid(id: Run['id'], pid: number): void;
  setRunLive(id: Run['id'], live_turns: number, live_tool: string | null): void;
  setRunSession(id: Run['id'], session_id: string): void;
  liveRuns(kind: RunKind): Map<TaskId, { started_at: string; live_turns: number; live_tool: string | null }>;
  openRuns(): Run[];
  latestRunModels(): Map<TaskId, string>;
  changedPathsOf(task_ids: readonly TaskId[]): Map<TaskId, string[]>;
  finishRun(id: Run['id'], r: Partial<Omit<Run, 'id' | 'task_id' | 'kind' | 'attempt' | 'started_at' | 'log_path' | 'model'>>): void;
  runsForTask(task_id: TaskId): Run[];
  countRunningResolves(): number;
  countRunningUnblocks(): number;
  countRunningReviews(): number;
  countRunningVerifies(): number;
  slotsUsed(): number;
  supportRunsUsed(): number;
  pidRuns(days: number): PidRun[];
  runningTaskRuns(): RunningTaskRun[];
  unfinishedPids(): { pid: number; pid_at: string }[];
}
