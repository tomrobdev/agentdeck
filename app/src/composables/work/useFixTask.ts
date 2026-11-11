import { useQuery } from '@tanstack/vue-query';
import { reposQuery } from '../../api/repos';
import type { TaskSummary } from '../../api/types';
import { fixTaskCommand } from '../../lib/runs/terminal';
import { fixReason } from '../../lib/work/task-badges';
import { canFix } from '../../lib/work/task-view';
import { useTerminal } from '../runs/useTerminal';
import { useActions } from '../shared/useActions';

type Fixable = Pick<TaskSummary, 'id' | 'title' | 'status' | 'pr_state' | 'stop_reason' | 'auto_merge_view' | 'worktree' | 'repo_id'>;

export function useFixTask() {
  const terminal = useTerminal();
  const { run, flash } = useActions();
  const repos = useQuery(reposQuery());

  const canFixHere = (t: Pick<TaskSummary, 'status' | 'pr_state' | 'waiting'>) => terminal.available.value && canFix(t);

  function fix(t: Fixable) {
    const cwd = t.worktree ?? repos.data.value?.find((r) => r.id === t.repo_id)?.path ?? null;
    if (!cwd) return flash(`Can't find the checkout for #${t.id}`);
    return run(() => terminal.open(`#${t.id} fix: ${t.title}`, cwd, fixTaskCommand(t, fixReason(t))));
  }
  return { canFixHere, fix, available: terminal.available, terminalName: terminal.name };
}
