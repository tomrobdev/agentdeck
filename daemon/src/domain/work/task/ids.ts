// Task ids as a person names them in a list.
import { type TaskId, parseId } from '../../shared/index.ts';

export function parseTaskIds(value: unknown): TaskId[] | null {
  if (value === undefined || value === null || value === '') return [];
  const items = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(items)) return null;
  const ids = items.map((i) => parseId<TaskId>(i));
  if (!ids.every((i): i is TaskId => i !== null)) return null;
  return [...new Set(ids)];
}
