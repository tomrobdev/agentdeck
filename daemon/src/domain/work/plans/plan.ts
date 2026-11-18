// A plan: an HTML document that says how a task will be done, step by step, attached to the task.
import type { TaskId } from '#domain/shared/index.ts';
import { AGENTDECK_FOLDER } from '#domain/repos/index.ts';

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

/** A task's own plan with its HTML: the one stored under the task's numbered name. */
export type OwnPlan = Omit<TaskPlan, keyof ParsedPlan> & { html: string };

export function toPlan({ html, ...row }: OwnPlan): TaskPlan {
  return {
    ...row,
    ...(parsePlan(html) ?? { version: '1', title: 'Untitled plan', summary: null, steps: [] }),
  };
}

export const PLAN_FILE = `${AGENTDECK_FOLDER}/plan.html`;
export const PLAN_GIVEN_FILE = `${AGENTDECK_FOLDER}/plan-given.html`;
export const PLAN_LIMIT = 512 * 1024;

const MARKER = /<html\b[^>]*\bdata-agentdeck-plan(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/i;

export function planSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 60).replace(/-+$/, '') || 'plan';
}

export const planFileName = (taskId: number, title: string): string => `${taskId}-${planSlug(title)}.html`;

export const isOwnPlanName = (taskId: number, name: string): boolean => new RegExp(`^${taskId}-[a-z0-9-]+\\.html$`).test(name);

export function parsePlan(html: string): ParsedPlan | null {
  return readPlan(html)?.plan ?? null;
}

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

function doneCriteria(body: string): string[] {
  const el = /<(\w+)\b([^>]*\bdata-plan-done\b[^>]*)>([\s\S]*?)<\/\1\s*>/i.exec(body);
  if (!el) return [];
  const items = [...el[3].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map((li) => text(li[1])).filter(Boolean);
  if (items.length) return items;
  const whole = text(el[3]);
  return whole ? [whole] : [];
}

export function planProgress(steps: PlanStep[]): { finished: number; total: number } {
  return { finished: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: steps.length };
}

const isFinished = (s: PlanStep) => s.status === 'done' || s.status === 'skipped';

export function linkedSteps(html: string, ids: string[] | null): PlanStep[] | null {
  const plan = parsePlan(html);
  return plan && plan.steps.filter((s) => ids === null || (s.id !== null && ids.includes(s.id)));
}

export const unfinishedSteps = (steps: PlanStep[]): PlanStep[] => steps.filter((s) => !isFinished(s));

export function unfinishedSummary(steps: PlanStep[]): string {
  const list = steps.map((s) => `${s.id ?? s.title} (${s.status})`).join(', ');
  return `left ${steps.length === 1 ? 'a linked plan step' : 'linked plan steps'} unfinished: ${list}`;
}

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

export function missingFollowedSteps(plan: ParsedPlan, followers: PlanFollower[]): { id: number; missing: string[] }[] {
  const have = new Set(plan.steps.flatMap((s) => (s.id === null ? [] : [s.id])));
  return followers.flatMap((f) => {
    const missing = (f.steps ?? []).filter((id) => !have.has(id));
    return missing.length ? [{ id: f.id, missing }] : [];
  });
}

function sectionsById(html: string): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  for (const s of stepSections(html)) if (s.id !== null && !out.has(s.id)) out.set(s.id, s);
  return out;
}

function stepSections(html: string): { id: string | null; start: number; end: number }[] {
  const out: { id: string | null; start: number; end: number }[] = [];
  for (const m of ignoringSkipped(html).matchAll(/<section\b([^>]*)>[\s\S]*?<\/section\s*>/gi)) {
    const attrs = attributes(m[1]);
    if (!('data-plan-step' in attrs)) continue;
    out.push({ id: attrs.id || null, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function ignoringSkipped(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, (m) => ' '.repeat(m.length));
}

function attributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

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
