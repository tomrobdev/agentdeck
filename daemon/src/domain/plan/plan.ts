// A plan: an HTML document that says how a task will be done, step by step, attached to the task.
// The format (docs/plan-format.md) marks the parts a program reads with data attributes, so the
// page stays free-form HTML for a person and parses here with a few patterns. Pure: no I/O.

export type PlanStepStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
export const PLAN_STEP_STATUSES: PlanStepStatus[] = ['todo', 'doing', 'done', 'blocked', 'skipped'];

export interface PlanStep {
  id: string | null; // the section's id, for linking into the page
  title: string;
  status: PlanStepStatus;
}

export interface ParsedPlan {
  version: string;
  title: string;
  summary: string | null;
  steps: PlanStep[];
}

/** Where a plan came from: a file on the task's branch, or attached with `agentdeck attach` or the API. */
export type PlanSource = 'branch' | 'attached';

/** A stored plan as the API returns it: parsed, without its HTML. */
export interface TaskPlan extends ParsedPlan {
  id: number;
  task_id: number;
  name: string; // the path on the branch, or the attached file's name
  source: PlanSource;
  created_at: string;
  updated_at: string;
}

/** Where agents write plans on a task's branch. */
export const PLAN_DIR = 'docs/plans/';
/** Bigger plans are refused: a plan is read on every task view. */
export const PLAN_LIMIT = 512 * 1024;

const MARKER = /<html\b[^>]*\bdata-agentdeck-plan(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/i;

/** Whether a branch file could be a plan: HTML under PLAN_DIR. Its content decides (parsePlan). */
export const isPlanPath = (path: string) => path.startsWith(PLAN_DIR) && /\.html?$/i.test(path);

/** The plan in `html`, or null if it doesn't carry the marker on its <html> tag. */
export function parsePlan(html: string): ParsedPlan | null {
  const doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  const marker = MARKER.exec(doc);
  if (!marker) return null;
  const version = marker[1] ?? marker[2] ?? marker[3] ?? '1';

  const steps: PlanStep[] = [];
  for (const m of doc.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi)) {
    const attrs = attributes(m[1]);
    if (!('data-plan-step' in attrs)) continue;
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(m[2]);
    const status = (attrs['data-status'] ?? '').trim().toLowerCase() as PlanStepStatus;
    steps.push({
      id: attrs.id || null,
      title: (heading ? text(heading[1]) : '') || attrs['data-plan-step'] || `Step ${steps.length + 1}`,
      status: PLAN_STEP_STATUSES.includes(status) ? status : 'todo',
    });
  }

  const summary = /<(\w+)\b([^>]*\bdata-plan-summary\b[^>]*)>([\s\S]*?)<\/\1\s*>/i.exec(doc);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc) ?? /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(doc);
  return {
    version,
    title: (title && text(title[1])) || 'Untitled plan',
    summary: (summary && text(summary[3])) || null,
    steps,
  };
}

/** How far a plan has got: done and skipped steps count as finished. */
export function planProgress(steps: PlanStep[]): { finished: number; total: number } {
  return { finished: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: steps.length };
}

/** An attached plan's name: the file's base name, so attaching the same file again replaces it. */
export function planName(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf('/') + 1).trim() || 'plan.html';
}

/** A tag's attributes, names lower-cased. A bare attribute has the value ''. */
function attributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** The text of an HTML fragment: tags dropped (block tags leave a space), entities decoded, whitespace collapsed. */
function text(fragment: string): string {
  const flat = fragment.replace(
    /<\/?(?:address|article|blockquote|br|dd|div|dl|dt|h[1-6]|hr|li|ol|p|section|table|td|th|tr|ul)\b[^>]*>/gi,
    ' ',
  );
  return decode(flat.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  mdash: '—',
  ndash: '–',
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
