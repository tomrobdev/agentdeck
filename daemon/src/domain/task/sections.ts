/** Splits a task prompt into its sections (PROMPT_SECTIONS in task.ts), in either form: `## Goal` headings or the older `Goal:` lines. */

export interface PromptSection {
  /** The section's name as written, such as "Goal" or "Definition of done". */
  name: string;
  /** The text under it, trimmed. */
  body: string;
}

export interface ParsedPrompt {
  /** Text before the first section; the whole prompt when it has none. */
  preamble: string;
  sections: PromptSection[];
}

/** The section names a prompt may have, as in PROMPT_SECTIONS. The old form is only recognised for these. */
export const SECTION_NAMES = ['Goal', 'Context', 'Change', 'Out of scope', 'Constraints', 'Definition of done'];

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const fence = /^[ \t]*(```|~~~)/;

const canonical = (name: string): string | null => SECTION_NAMES.find((n) => n.toLowerCase() === name.trim().toLowerCase()) ?? null;

/** A line that opens a section, with the text after the name on that line (old form only). */
function opening(line: string): { name: string; rest: string } | null {
  const heading = HEADING.exec(line);
  if (heading) {
    const name = canonical(heading[1]);
    return name ? { name, rest: '' } : null;
  }
  const old = /^([A-Za-z][A-Za-z ]*?):[ \t]*(.*)$/.exec(line);
  if (!old) return null;
  const name = canonical(old[1]);
  return name ? { name, rest: old[2] } : null;
}

export function parsePromptSections(prompt: string): ParsedPrompt {
  const preamble: string[] = [];
  const found: { name: string; lines: string[] }[] = [];
  let inFence = false;
  for (const line of prompt.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence.test(line)) inFence = !inFence;
    const open = inFence ? null : opening(line);
    if (open) found.push({ name: open.name, lines: open.rest ? [open.rest] : [] });
    else (found.at(-1)?.lines ?? preamble).push(line);
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: found.map((s) => ({ name: s.name, body: s.lines.join('\n').trim() })),
  };
}

/** One section's body, or null when the prompt has no such section. */
export function promptSection(prompt: string, name: string): string | null {
  const want = canonical(name) ?? name;
  return parsePromptSections(prompt).sections.find((s) => s.name === want)?.body ?? null;
}
