// A plan: an HTML document that says how a task will be done, step by step, attached to the task.
// The format (docs/plan-format.md) marks the parts a program reads with data attributes, so the
// page stays free-form HTML for a person and parses here with a few patterns. Pure: no I/O.

export type PlanStepStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
export const PLAN_STEP_STATUSES: PlanStepStatus[] = ['todo', 'doing', 'done', 'blocked', 'skipped'];

export interface PlanStep {
  id: string | null; // the section's id, for linking into the page
  title: string;
  status: PlanStepStatus;
  done: string[]; // the done criteria, one per <li> of the step's [data-plan-done] element
}

export interface ParsedPlan {
  version: string;
  title: string;
  summary: string | null;
  steps: PlanStep[];
}

/**
 * Where a stored plan came from: attached by a person (`agentdeck add|edit --plan <file>`, `agentdeck attach`, the API),
 * or written by a worker in the plan file. 'branch' plans were collected from a task's branch before plans moved into
 * AgentDeck; they still show on their tasks.
 */
export type PlanSource = 'attached' | 'worker' | 'branch';

/** A stored plan as the API returns it: parsed, without its HTML. */
export interface TaskPlan extends ParsedPlan {
  id: number;
  task_id: number; // the task the plan belongs to: the one it was first attached to
  name: string; // `<task id>-<slug>.html` (planFileName); older plans keep the name they were stored under
  source: PlanSource;
  created_at: string;
  updated_at: string;
}

/** The folder in a task's worktree that holds AgentDeck's files for the run. Git ignores it. */
export const PLAN_FOLDER = '.agentdeck';
/** Where a run's plan sits in the task's worktree, for the worker to read and update. Never committed. */
export const PLAN_FILE = `${PLAN_FOLDER}/plan.html`;
/** Bigger plans are refused: a plan is read on every task view. */
export const PLAN_LIMIT = 512 * 1024;

const MARKER = /<html\b[^>]*\bdata-agentdeck-plan(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/i;

/** A plan title as a file-name slug: lower case, words joined by dashes, at most 60 characters. */
export function planSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 60).replace(/-+$/, '') || 'plan';
}

/** A plan's name: the number of the task it belongs to and a slug of its title, e.g. `112-plans-in-agentdeck.html`. */
export const planFileName = (taskId: number, title: string): string => `${taskId}-${planSlug(title)}.html`;

/** Whether `name` is a name planFileName gives task `taskId`'s plan: the task's own plan, not one stored before plans had numbers. */
export const isOwnPlanName = (taskId: number, name: string): boolean => new RegExp(`^${taskId}-[a-z0-9-]+\\.html$`).test(name);

/** The plan in `html`, or null if it doesn't carry the marker on its <html> tag. */
export function parsePlan(html: string): ParsedPlan | null {
  return readPlan(html)?.plan ?? null;
}

/** A parsed plan plus each step's body text (its heading and done criteria left out), in step order, for prompts. */
export function parsePlanWithText(html: string): { plan: ParsedPlan; texts: string[] } | null {
  return readPlan(html);
}

function readPlan(html: string): { plan: ParsedPlan; texts: string[] } | null {
  const doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  const marker = MARKER.exec(doc);
  if (!marker) return null;
  const version = marker[1] ?? marker[2] ?? marker[3] ?? '1';

  const steps: PlanStep[] = [];
  const texts: string[] = [];
  for (const m of doc.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi)) {
    const attrs = attributes(m[1]);
    if (!('data-plan-step' in attrs)) continue;
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(m[2]);
    const status = (attrs['data-status'] ?? '').trim().toLowerCase() as PlanStepStatus;
    steps.push({
      id: attrs.id || null,
      title: (heading ? text(heading[1]) : '') || attrs['data-plan-step'] || `Step ${steps.length + 1}`,
      status: PLAN_STEP_STATUSES.includes(status) ? status : 'todo',
      done: doneCriteria(m[2]),
    });
    texts.push(
      text(
        m[2].replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/i, '').replace(/<(\w+)\b[^>]*\bdata-plan-done\b[^>]*>[\s\S]*?<\/\1\s*>/i, ''),
      ),
    );
  }

  const summary = /<(\w+)\b([^>]*\bdata-plan-summary\b[^>]*)>([\s\S]*?)<\/\1\s*>/i.exec(doc);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc) ?? /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(doc);
  return {
    plan: {
      version,
      title: (title && text(title[1])) || 'Untitled plan',
      summary: (summary && text(summary[3])) || null,
      steps,
    },
    texts,
  };
}

/** A step's done criteria: the first [data-plan-done] element's <li> texts, or its whole text as one item. */
function doneCriteria(body: string): string[] {
  const el = /<(\w+)\b([^>]*\bdata-plan-done\b[^>]*)>([\s\S]*?)<\/\1\s*>/i.exec(body);
  if (!el) return [];
  const items = [...el[3].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map((li) => text(li[1])).filter(Boolean);
  if (items.length) return items;
  const whole = text(el[3]);
  return whole ? [whole] : [];
}

/** How far a plan has got: done and skipped steps count as finished. */
export function planProgress(steps: PlanStep[]): { finished: number; total: number } {
  return { finished: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: steps.length };
}

const isFinished = (s: PlanStep) => s.status === 'done' || s.status === 'skipped';

/** The steps a task is linked to in `html`: those named by `ids`, or every step when `ids` is null. Null if it isn't a plan. */
export function linkedSteps(html: string, ids: string[] | null): PlanStep[] | null {
  const plan = parsePlan(html);
  return plan && plan.steps.filter((s) => ids === null || (s.id !== null && ids.includes(s.id)));
}

/** The steps a run was meant to finish but left neither done nor skipped. */
export const unfinishedSteps = (steps: PlanStep[]): PlanStep[] => steps.filter((s) => !isFinished(s));

/** The history line for linked steps a done run left unfinished. */
export function unfinishedSummary(steps: PlanStep[]): string {
  const list = steps.map((s) => `${s.id ?? s.title} (${s.status})`).join(', ');
  return `left ${steps.length === 1 ? 'a linked plan step' : 'linked plan steps'} unfinished: ${list}`;
}

/**
 * The stored plan with a task's linked steps taken from the plan file a run left (`written`): each linked step's whole
 * section (its status and any note the worker put in it) replaces the stored one. Everything else stays as stored,
 * because sibling tasks on one plan may run at the same time and write back their own steps. `ids` null links every
 * step. Steps match by id; steps without one match by their order among the steps without one. A `written` that is not
 * a plan changes nothing.
 */
export function mergePlanSteps(stored: string, written: string, ids: string[] | null): string {
  if (!parsePlan(written)) return stored;
  const fresh = new Map(stepSections(written).map((s) => [s.key, s]));
  let out = stored;
  for (const step of stepSections(stored).reverse()) {
    const linked = ids === null || (step.id !== null && ids.includes(step.id));
    const next = linked ? fresh.get(step.key) : undefined;
    if (next) out = out.slice(0, step.start) + written.slice(next.start, next.end) + out.slice(step.end);
  }
  return out;
}

/** Each step's <section> in `html`, by position, leaving out ones inside comments, scripts, styles and templates. */
function stepSections(html: string): { key: string; id: string | null; start: number; end: number }[] {
  // Blank out what parsePlan ignores, keeping every offset, so positions point into `html`.
  const masked = html
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, (m) => ' '.repeat(m.length));
  const out: { key: string; id: string | null; start: number; end: number }[] = [];
  let unnamed = 0;
  for (const m of masked.matchAll(/<section\b([^>]*)>[\s\S]*?<\/section\s*>/gi)) {
    const attrs = attributes(m[1]);
    if (!('data-plan-step' in attrs)) continue;
    const id = attrs.id || null;
    out.push({ key: id === null ? `#${unnamed++}` : `id:${id}`, id, start: m.index, end: m.index + m[0].length });
  }
  return out;
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
