// A task prompt's sections: the format, and one parser that reads either style (## headings or Heading: label lines) under old names or new.

export const PROMPT_SECTIONS = `## Current problem
What is wrong or missing today, and where: the files, functions and screens.

## Expected outcome
- What a reviewer can check once it is done, one bullet each.
- The last bullet: the repo's test command passes.

## Out of scope
What not to touch. Optional.

## Constraints
Limits the agent must keep to, such as no new dependencies or no changes to package.json. Optional.`;

const SECTION_ORDER = ['Current problem', 'Expected outcome', 'Change', 'Out of scope', 'Constraints'];

const REQUIRED_SECTIONS = ['Current problem', 'Expected outcome'];

const SECTION_NAMES: Record<string, string> = {
  'current problem': 'Current problem',
  goal: 'Current problem',
  context: 'Current problem',
  'expected outcome': 'Expected outcome',
  'definition of done': 'Expected outcome',
  change: 'Change',
  'out of scope': 'Out of scope',
  constraints: 'Constraints',
};

export interface PromptSection {
  name: string;
  heading: string;
  body: string;
}

export interface ParsedPrompt {
  preamble: string;
  sections: PromptSection[];
}

export function parsePrompt(prompt: string): ParsedPrompt {
  const preamble: string[] = [];
  const sections: { name: string; heading: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of prompt.split('\n')) {
    const heading = fenced ? null : /^##\s+(.+?)\s*$/.exec(line);
    const label = fenced || heading ? null : /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*?)\s*$/.exec(line);
    const labelName = label ? SECTION_NAMES[label[1].toLowerCase()] : undefined;
    if (heading) sections.push({ name: SECTION_NAMES[heading[1].toLowerCase()] ?? heading[1], heading: heading[1], lines: [] });
    else if (label && labelName) sections.push({ name: labelName, heading: label[1], lines: label[2] ? [label[2]] : [] });
    else {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      (sections.at(-1)?.lines ?? preamble).push(line);
    }
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map((s) => ({ name: s.name, heading: s.heading, body: s.lines.join('\n').trim() })),
  };
}

function sectionText(parsed: ParsedPrompt, name: string): string | null {
  const wanted = name.toLowerCase();
  const bodies = parsed.sections
    .filter((s) => (s.name.toLowerCase() === wanted || s.heading.toLowerCase() === wanted) && s.body)
    .map((s) => s.body);
  return bodies.length ? bodies.join('\n\n') : null;
}

export const promptSection = (prompt: string, name: string): string | null => sectionText(parsePrompt(prompt), name);

export function promptGoal(prompt: string, maxLines = 6): string {
  const parsed = parsePrompt(prompt);
  const text = parsed.sections.length
    ? (sectionText(parsed, 'Goal') ??
      sectionText(parsed, 'Current problem') ??
      parsed.sections.find((s) => s.body)?.body ??
      parsed.preamble)
    : prompt.trim();
  return text.split('\n').slice(0, maxLines).join('\n').trim();
}

export interface PromptBrief {
  sections: { name: string; body: string }[];
  rest: string;
}

export function promptBrief(prompt: string): PromptBrief {
  const parsed = parsePrompt(prompt);
  if (!parsed.sections.length) return { sections: [], rest: prompt.trim() };
  const sections = SECTION_ORDER.flatMap((name) => {
    const body = sectionText(parsed, name);
    return body === null
      ? []
      : [
          {
            name,
            body: parsed.sections
              .filter((s) => s.name === name && s.body)
              .map((s) => s.body)
              .join('\n\n'),
          },
        ];
  });
  const rest = parsed.sections.filter((s) => !SECTION_ORDER.includes(s.name) && s.body).map((s) => `## ${s.heading}\n${s.body}`);
  return { sections, rest: [parsed.preamble, ...rest].filter(Boolean).join('\n\n') };
}

export function shapePrompt(prompt: string): { prompt: string; warnings: string[] } {
  const parsed = parsePrompt(prompt);
  if (!parsed.sections.length)
    return { prompt, warnings: [`the prompt has no sections; write it under ${REQUIRED_SECTIONS.map((n) => `## ${n}`).join(' and ')}`] };
  const warnings = REQUIRED_SECTIONS.filter((n) => sectionText(parsed, n) === null).map((n) => `the prompt has no ## ${n} section`);
  const others = parsed.sections.map((s) => s.name).filter((n, i, all) => !SECTION_ORDER.includes(n) && all.indexOf(n) === i);
  const blocks = [...SECTION_ORDER, ...others].flatMap((name) => {
    const bodies = parsed.sections.filter((s) => s.name === name && s.body).map((s) => s.body);
    return bodies.length ? [`## ${name}\n${bodies.join('\n\n')}`] : [];
  });
  return { prompt: [parsed.preamble, ...blocks].filter(Boolean).join('\n\n'), warnings };
}
