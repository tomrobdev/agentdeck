// Task ids as a person names them in a list. Pure. The entry points (the CLI's flags, the API's request bodies) read
// id lists with this and word their own error; the use cases take the branded ids.
import { type TaskId, parseId } from '../shared/id.ts';

/**
 * Task ids from a list ([12, 14]) or typed text ("12,14", "#12 #14"), each a whole number above 0, without repeats.
 * Empty when none are given; null when any of them isn't a task id.
 */
export function parseTaskIds(value: unknown): TaskId[] | null {
  if (value === undefined || value === null || value === '') return [];
  const items = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(items)) return null;
  const ids = items.map((i) => parseId<TaskId>(i));
  if (!ids.every((i): i is TaskId => i !== null)) return null;
  return [...new Set(ids)];
}
