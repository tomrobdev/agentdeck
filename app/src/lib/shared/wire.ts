// What the API sends as JSON text in a task: the dashboard reads it here. The daemon's domain has these as values (the mapper in
// db/mappers.ts parses them); the API keeps the stored shape. Pure, so the daemon's tests can import it with taskBadges.ts.
import { type Needs, type UnblockQuestion, isNeeds } from '../../../../daemon/src/domain/work/index.ts';

function parse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** A task's `needs` text, or null when it has none or it is unreadable. */
export function needsOf(json: string | null): Needs | null {
  const n = parse(json);
  return isNeeds(n) ? n : null;
}

/** A task's `question` text, or null when it has none or it is unreadable. */
export function questionOf(json: string | null): UnblockQuestion | null {
  const q = parse(json) as Partial<UnblockQuestion> | null;
  return q && typeof q.question === 'string' && Array.isArray(q.options) ? { question: q.question, options: q.options.map(String) } : null;
}
