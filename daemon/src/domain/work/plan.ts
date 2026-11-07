// A plan: an HTML document that says how a task will be done, step by step, attached to the task.
// The format (docs/plan-format.md) marks the parts a program reads with data attributes, so the
// page stays free-form HTML for a person and parses here with a few patterns. Pure: no I/O.
import type { TaskId } from '../shared/id.ts';

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
  task_id: TaskId; // the task the plan belongs to: the one it was first attached to
  name: string; // `<task id>-<slug>.html` (planFileName); older plans keep the name they were stored under
  source: PlanSource;
  created_at: string;
  updated_at: string;
}

/** The folder in a task's worktree that holds AgentDeck's files for the run. Git ignores it. */
export const PLAN_FOLDER = '.agentdeck';
/** Where a run's plan sits in the task's worktree, for the worker to read and update. Never committed. */
export const PLAN_FILE = `${PLAN_FOLDER}/plan.html`;
/**
 * The copy of the plan a run was given, kept beside PLAN_FILE so that what the run changed can be told from what it
 * left alone, even after a daemon restart cut the run off. The worker never touches it.
 */
export const PLAN_GIVEN_FILE = `${PLAN_FOLDER}/plan-given.html`;
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
  const doc = ignoringSkipped(html);
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
 * The stored plan with the linked steps a run changed taken from the plan file it left (`written`). `given` is the copy
 * of the plan the run was given: a linked step whose section in `written` differs from its section in `given` was
 * changed by the run, and its whole section (its status and any note the worker put in it) replaces the stored one.
 * Steps the run left as it got them keep what is stored, since a sibling task or a person may have changed them since.
 * Everything outside the linked steps stays as stored. `ids` null links every step. Only steps with an id are saved
 * back: they match by id, so a step the worker adds, moves or leaves without an id never lands on another one. A
 * `written` that is not a plan changes nothing.
 */
export function mergePlanSteps(stored: string, written: string, ids: string[] | null, given: string): string {
  if (!parsePlan(written)) return stored;
  const fresh = sectionsById(written);
  const before = sectionsById(given);
  let out = stored;
  for (const step of stepSections(stored).reverse()) {
    if (step.id === null || (ids !== null && !ids.includes(step.id))) continue;
    const next = fresh.get(step.id);
    if (!next) continue;
    const section = written.slice(next.start, next.end);
    const was = before.get(step.id);
    if (was && given.slice(was.start, was.end) === section) continue;
    out = out.slice(0, step.start) + section + out.slice(step.end);
  }
  return out;
}

/**
 * What the stored plan becomes after a run left `written` in the plan file. The run keeps the whole file (steps and
 * notes it added outside its linked steps too) when the plan is the task's own (`own`), no other task follows it
 * (`followed`), and nothing changed the stored plan while it ran (`stored` still equals `given`, the copy it was
 * given). Otherwise only the linked steps it changed are saved back (mergePlanSteps). `given` null (a run whose copy
 * is missing) compares with the stored plan instead and never keeps the whole file.
 */
export function planAfterRun(run: {
  stored: string;
  given: string | null;
  written: string;
  ids: string[] | null;
  own: boolean;
  followed: boolean;
}): string {
  if (!parsePlan(run.written)) return run.stored;
  if (run.own && !run.followed && run.given !== null && run.given === run.stored) return run.written;
  return mergePlanSteps(run.stored, run.written, run.ids, run.given ?? run.stored);
}

/** A task that follows a plan, with the step ids it links (null for every step). */
export interface PlanFollower {
  id: number;
  steps: string[] | null;
}

/** The followers that link step ids `plan` doesn't have, each with those ids. Empty when the plan keeps them all. */
export function missingFollowedSteps(plan: ParsedPlan, followers: PlanFollower[]): { id: number; missing: string[] }[] {
  const have = new Set(plan.steps.flatMap((s) => (s.id === null ? [] : [s.id])));
  return followers.flatMap((f) => {
    const missing = (f.steps ?? []).filter((id) => !have.has(id));
    return missing.length ? [{ id: f.id, missing }] : [];
  });
}

/** The <section> of each step that has an id in `html`, by id (the first when two share one). */
function sectionsById(html: string): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  for (const s of stepSections(html)) if (s.id !== null && !out.has(s.id)) out.set(s.id, s);
  return out;
}

/** Each step's <section> in `html`, by position, leaving out ones inside comments, scripts, styles and templates. */
function stepSections(html: string): { id: string | null; start: number; end: number }[] {
  const out: { id: string | null; start: number; end: number }[] = [];
  for (const m of ignoringSkipped(html).matchAll(/<section\b([^>]*)>[\s\S]*?<\/section\s*>/gi)) {
    const attrs = attributes(m[1]);
    if (!('data-plan-step' in attrs)) continue;
    out.push({ id: attrs.id || null, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * `html` with what a plan ignores (comments, scripts, styles, templates) blanked out, every offset kept, so positions
 * found in the result point into `html`.
 */
function ignoringSkipped(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, (m) => ' '.repeat(m.length));
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
