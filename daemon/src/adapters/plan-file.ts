// The plan file in a task's worktree (PLAN_FILE): where a run's plan is put for the worker and read back after it, with
// the copy the run was given beside it (PLAN_GIVEN_FILE). Their folder carries a .gitignore that ignores everything in
// it, so `git add -A` (commitLeftovers) never commits them.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAN_FILE, PLAN_FOLDER, PLAN_GIVEN_FILE, PLAN_LIMIT } from '../domain/plan/plan.ts';

/** Make the plan folder, ignored by git. Run before every run, plan or not. */
async function ensurePlanFolder(worktree: string): Promise<void> {
  const dir = join(worktree, PLAN_FOLDER);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.gitignore'), '# AgentDeck: the run plan file. Never committed.\n*\n');
}

/**
 * Put `html` in the worktree's plan file and keep a copy as the plan the run was given, or remove both when the run
 * has no plan (so a plan written by the worker is new).
 */
export async function writePlanFile(worktree: string, html: string | null): Promise<void> {
  await ensurePlanFolder(worktree);
  await writeGivenPlan(worktree, html);
  const file = join(worktree, PLAN_FILE);
  if (html === null) await rm(file, { force: true });
  else await writeFile(file, html);
}

/** Record `html` as the plan the run was given (or remove the copy): after a write-back, what is already saved. */
export async function writeGivenPlan(worktree: string, html: string | null): Promise<void> {
  const file = join(worktree, PLAN_GIVEN_FILE);
  if (html === null) await rm(file, { force: true });
  else await writeFile(file, html);
}

/** The worktree's plan file, or null when there is none or it is bigger than a plan may be. */
export function readPlanFile(worktree: string): Promise<string | null> {
  return readLimited(join(worktree, PLAN_FILE));
}

/** The copy of the plan the run was given, or null when there is none. */
export function readGivenPlan(worktree: string): Promise<string | null> {
  return readLimited(join(worktree, PLAN_GIVEN_FILE));
}

async function readLimited(file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > PLAN_LIMIT) return null;
  return readFile(file, 'utf8');
}
