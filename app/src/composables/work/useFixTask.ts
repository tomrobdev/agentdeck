import type { TaskSummary } from '#api/types.ts';
import { fixTaskCommand } from '#lib/runs/terminal.ts';
import { fixReason } from '#lib/work/task-badges.ts';
import { canFix } from '#lib/work/task-view.ts';
import { useClaudeSession } from '#composables/runs/useClaudeSession.ts';

type Fixable = Pick<TaskSummary, 'id' | 'title' | 'status' | 'pr_state' | 'stop_reason' | 'auto_merge_view' | 'worktree' | 'repo_id'>;

export function useFixTask() {
  const session = useClaudeSession();
  const canFixHere = (t: Pick<TaskSummary, 'status' | 'pr_state' | 'waiting'>) => session.available.value && canFix(t);
  const fix = (t: Fixable) => session.start(t, 'fix', fixTaskCommand(t, fixReason(t)));
  return { canFixHere, fix, available: session.available, terminalName: session.name };
}
