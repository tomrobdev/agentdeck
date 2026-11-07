// GLOSSARY.md's avoid-words, and a scan for them in source text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

export type GlossaryTerm = { term: string; avoid: string[] };

/** The terms of a glossary: each `**Term**:` line, with the words of the `_Avoid_:` line that follows it. */
export function parseGlossary(text: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  for (const line of text.split('\n')) {
    const term = line.match(/^\*\*(.+?)\*\*:/);
    if (term) terms.push({ term: term[1], avoid: [] });
    const avoid = line.match(/^_Avoid_:\s*(.+)$/);
    if (avoid && terms.length)
      terms[terms.length - 1].avoid.push(
        ...avoid[1]
          .split(',')
          .map((w) => w.trim())
          .filter(Boolean),
      );
  }
  return terms;
}

export function readGlossary(): GlossaryTerm[] {
  return parseGlossary(readFileSync(join(ROOT, 'GLOSSARY.md'), 'utf8'));
}

/** A case-insensitive whole-word pattern for the words, or null for none. */
export function avoidPattern(words: string[]): RegExp | null {
  if (!words.length) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
}

/** The 1-based numbers of the lines of `text` that say an avoid-word. */
export function avoidedLines(text: string, words: string[]): { line: number; text: string }[] {
  const re = avoidPattern(words);
  if (!re) return [];
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter((l) => re.test(l.text));
}
