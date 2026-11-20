// A task's footprint, the files it will touch, and whether two tasks' footprints overlap so they shouldn't run together.
import type { TaskId } from '#domain/shared/index.ts';
import { parsePlanWithText } from '#domain/work/plans/plan.ts';
import { pathsNamedIn } from '#domain/work/plans/prompt-paths.ts';
import { meetAt } from '#domain/work/task/proposal-check.ts';

export interface FootprintSource {
  prompt: string;
  plan: { html: string; steps: readonly string[] | null } | null;
  changed: readonly string[];
}

export interface Footprinted {
  id: TaskId;
  paths: readonly string[];
}

export function stepPaths(html: string, ids: readonly string[] | null): string[] {
  const read = parsePlanWithText(html);
  if (!read) return [];
  return read.plan.steps.flatMap((step, i) => {
    const unfinished = step.status !== 'done' && step.status !== 'skipped';
    const linked = ids === null || (step.id !== null && ids.includes(step.id));
    return unfinished && linked ? pathsNamedIn([read.texts[i] ?? '', ...step.done].join('\n')) : [];
  });
}

export function footprint(source: FootprintSource): string[] {
  const steps = source.plan ? stepPaths(source.plan.html, source.plan.steps) : [];
  return [...new Set([...pathsNamedIn(source.prompt), ...steps, ...source.changed])];
}

export const footprintsOverlap = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((p) => b.some((q) => meetAt(p, q) !== null));

export function overlapWith(own: readonly string[], running: readonly Footprinted[]): TaskId | null {
  return running.find((r) => footprintsOverlap(own, r.paths))?.id ?? null;
}
