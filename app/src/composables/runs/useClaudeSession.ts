import { useQuery } from '@tanstack/vue-query';
import { reposQuery } from '#api/repos.ts';
import type { TaskSummary } from '#api/types.ts';
import { useTerminal } from '#composables/runs/useTerminal.ts';
import { useActions } from '#composables/shared/useActions.ts';

type SessionTask = Pick<TaskSummary, 'id' | 'title' | 'repo_id'> & { worktree?: string | null };

export function useClaudeSession() {
  const { available, open, name } = useTerminal();
  const { run, flash } = useActions();
  const repos = useQuery(reposQuery());

  function start(task: SessionTask, label: string, command: string) {
    const cwd = task.worktree ?? repos.data.value?.find((r) => r.id === task.repo_id)?.path ?? null;
    if (!cwd) return flash(`Can't find the checkout for #${task.id}`);
    return run(() => open(`#${task.id} ${label}: ${task.title}`, cwd, command));
  }
  return { available, start, name };
}
