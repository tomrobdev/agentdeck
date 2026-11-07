// The goals file of each repo, `<GOALS_DIR>/<repo name>.md`, read by the planner.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOALS_DIR, ensureDirs } from '../config.ts';
import type { Repo } from '../domain/repos/repo.ts';

export function goalsPath(repo: Pick<Repo, 'name'>): string {
  return join(GOALS_DIR, `${repo.name}.md`);
}

export function readGoals(repo: Pick<Repo, 'name'>): string {
  const p = goalsPath(repo);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

export function deleteGoals(repo: Pick<Repo, 'name'>): void {
  rmSync(goalsPath(repo), { force: true });
}

export function writeGoals(repo: Pick<Repo, 'name'>, text: string): void {
  ensureDirs();
  writeFileSync(goalsPath(repo), text);
}
