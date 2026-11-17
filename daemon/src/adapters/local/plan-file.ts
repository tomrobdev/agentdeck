// The plan file in a task's worktree (PLAN_FILE): where a run's plan is put for the worker and read back after it, with the copy the run was given beside it (PLAN_GIVEN_FILE).
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTDECK_FOLDER } from '#domain/repos/index.ts';
import { PLAN_FILE, PLAN_GIVEN_FILE, PLAN_LIMIT } from '#domain/work/index.ts';

async function ensurePlanFolder(worktree: string): Promise<void> {
  const dir = join(worktree, AGENTDECK_FOLDER);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.gitignore'), '# AgentDeck: the run plan file. Never committed.\n*\n');
}

export async function writePlanFile(worktree: string, html: string | null): Promise<void> {
  await ensurePlanFolder(worktree);
  await writeGivenPlan(worktree, html);
  const file = join(worktree, PLAN_FILE);
  if (html === null) await rm(file, { force: true });
  else await writeFile(file, html);
}

export async function writeGivenPlan(worktree: string, html: string | null): Promise<void> {
  const file = join(worktree, PLAN_GIVEN_FILE);
  if (html === null) await rm(file, { force: true });
  else await writeFile(file, html);
}

export function readPlanFile(worktree: string): Promise<string | null> {
  return readLimited(join(worktree, PLAN_FILE));
}

export function readGivenPlan(worktree: string): Promise<string | null> {
  return readLimited(join(worktree, PLAN_GIVEN_FILE));
}

async function readLimited(file: string): Promise<string | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > PLAN_LIMIT) return null;
  return readFile(file, 'utf8');
}
