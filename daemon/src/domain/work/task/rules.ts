// What a person may ask of a task: the limits on its fields and the checks on how it is added.
import { wholeNumberError } from '#domain/shared/index.ts';
import { MODELS, isModel } from '#domain/work/task/task.ts';

export const priorityError = (value: unknown): string | null => wholeNumberError('priority', value, -1000, 1000);
export const MOST_TURNS = 500;
export const maxTurnsError = (value: unknown): string | null => wholeNumberError('max_turns', value, 1, MOST_TURNS);
export const maxAttemptsError = (value: unknown): string | null => wholeNumberError('max_attempts', value, 1, 20);

export function modelError(model: string | undefined): string | null {
  if (model && !isModel(model)) return `model must be ${MODELS.join(', ')} or a full claude-… model id`;
  return null;
}

export function stepsNeedPlanError(planTask: number | null, steps: string[] | null): string | null {
  return planTask === null && steps ? '--steps needs --plan' : null;
}

export function archivedRepoError(repo: { name: string; archived_at: string | null }): string | null {
  return repo.archived_at ? `${repo.name} is archived; unarchive it first` : null;
}
