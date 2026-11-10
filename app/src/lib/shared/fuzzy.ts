const WORD_START = /[\s#/_\-.:]/;

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    run = at === from && from > 0 ? run + 1 : 0;
    score += 1 + run * 2;
    if (at === 0 || WORD_START.test(t[at - 1])) score += 3;
    score -= Math.min(at - from, 5) * 0.1;
    from = at + 1;
  }
  if (t === q) score += 1000;
  else if (t.startsWith(q)) score += 20;
  return score;
}

export function bestScore(query: string, fields: readonly string[]): number | null {
  let best: number | null = null;
  for (const f of fields) {
    const s = fuzzyScore(query, f);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

export function rank<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly string[],
  bonus: (item: T) => number = () => 0,
): T[] {
  const scored: { item: T; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const s = query.trim() ? bestScore(query, fields(item)) : 0;
    if (s !== null) scored.push({ item, score: s + bonus(item), at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((x) => x.item);
}
