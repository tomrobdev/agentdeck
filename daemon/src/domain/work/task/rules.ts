// What a person may ask of a task: the limits on its fields and the checks on how it is added.
// Each rule returns the message to show, or null when the input is fine. Pure: no I/O.
import { wholeNumberError } from '../../shared/index.ts';
import { MODELS, isModel } from './task.ts';

export const priorityError = (value: unknown): string | null => wholeNumberError('priority', value, -1000, 1000);
export const maxTurnsError = (value: unknown): string | null => wholeNumberError('max_turns', value, 1, 500);
export const maxAttemptsError = (value: unknown): string | null => wholeNumberError('max_attempts', value, 1, 20);

/** A typo in a model name would fail the run and use up an attempt, so refuse it up front. An empty model means the default. */
export function modelError(model: string | undefined): string | null {
  if (model && !isModel(model)) return `model must be ${MODELS.join(', ')} or a full claude-… model id`;
  return null;
}

/** Steps name steps of a plan, so they need one. */
export function stepsNeedPlanError(planTask: number | null, steps: string[] | null): string | null {
  return planTask === null && steps ? '--steps needs --plan' : null;
}

/** An archived repo takes no new tasks. */
export function archivedRepoError(repo: { name: string; archived_at: string | null }): string | null {
  return repo.archived_at ? `${repo.name} is archived; unarchive it first` : null;
}
