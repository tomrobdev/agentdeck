// The runs under way across every task, with the tail of each one's log, for the dashboard's Running view.
import type { App } from '#application/ports/app.ts';
import { liveMaxTurns, logTail } from '#domain/runs/index.ts';
import type { Run, RunKind } from '#domain/runs/index.ts';
import type { RunId, TaskId } from '#domain/shared/index.ts';

const TAIL_LINES = 6;

export interface LiveRunRow {
  run_id: RunId;
  task_id: TaskId;
  title: string;
  kind: RunKind;
  model: string | null;
  started_at: string;
  turns: number;
  max_turns: number;
  tool: string | null;
  lines: string[];
}

function tailOf(app: App, run: Run): string[] {
  try {
    return logTail(app.runLog.read(run.log_path), TAIL_LINES);
  } catch {
    return [];
  }
}

export function liveRuns(app: App): LiveRunRow[] {
  return app.openRuns().flatMap((run) => {
    const task = app.getTask(run.task_id);
    if (!task) return [];
    return [
      {
        run_id: run.id,
        task_id: task.id,
        title: task.title,
        kind: run.kind,
        model: run.model,
        started_at: run.started_at,
        turns: run.live_turns,
        max_turns: liveMaxTurns(run.kind, task.max_turns),
        tool: run.live_tool,
        lines: tailOf(app, run),
      },
    ];
  });
}
