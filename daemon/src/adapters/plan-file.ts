// The plan file in a task's worktree (PLAN_FILE): where a run's plan is put for the worker and read back after it.
// Its folder carries a .gitignore that ignores everything in it, so `git add -A` (commitLeftovers) never commits it.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAN_FILE, PLAN_FOLDER, PLAN_LIMIT } from '../domain/plan/plan.ts';

/** Make the plan folder, ignored by git. Run before every run, plan or not. */
async function ensurePlanFolder(worktree: string): Promise<void> {
  const dir = join(worktree, PLAN_FOLDER);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.gitignore'), '# AgentDeck: the run plan file. Never committed.\n*\n');
}

/** Put `html` in the worktree's plan file, or remove the file when the run has no plan (so a plan written by the worker is new). */
export async function writePlanFile(worktree: string, html: string | null): Promise<void> {
  await ensurePlanFolder(worktree);
  const file = join(worktree, PLAN_FILE);
  if (html === null) await rm(file, { force: true });
  else await writeFile(file, html);
}

/** The worktree's plan file, or null when there is none or it is bigger than a plan may be. */
export async function readPlanFile(worktree: string): Promise<string | null> {
  const file = join(worktree, PLAN_FILE);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > PLAN_LIMIT) return null;
  return readFile(file, 'utf8');
}
