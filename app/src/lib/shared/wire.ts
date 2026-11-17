import { type Needs, type UnblockQuestion, isNeeds } from '#daemon/domain/work/index.ts';

function parse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function needsOf(json: string | null): Needs | null {
  const n = parse(json);
  return isNeeds(n) ? n : null;
}

export function questionOf(json: string | null): UnblockQuestion | null {
  const q = parse(json) as Partial<UnblockQuestion> | null;
  return q && typeof q.question === 'string' && Array.isArray(q.options) ? { question: q.question, options: q.options.map(String) } : null;
}
