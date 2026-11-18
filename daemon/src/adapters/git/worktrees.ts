// Adapter for local git: worktrees, and committing and merging in them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKTREE_DIR } from '#src/config.ts';
import { branchName } from '#domain/work/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { Task } from '#domain/work/index.ts';
import { git } from '#adapters/git/exec.ts';
import { branchExists, refExists, startPoint } from '#adapters/git/refs.ts';

export async function ensureWorktree(repo: Repo, task: Task): Promise<{ branch: string; path: string }> {
  const branch = branchName(task);
  const path = task.checkout?.worktree ?? join(WORKTREE_DIR, repo.name, `task-${task.id}`);
  if (existsSync(path)) return { branch, path };

  mkdirSync(dirname(path), { recursive: true });
  await git(repo.path, 'worktree', 'prune');
  if (await branchExists(repo.path, branch)) {
    await git(repo.path, 'worktree', 'add', path, branch);
  } else {
    await git(repo.path, 'worktree', 'add', '--no-track', '-b', branch, path, await startPoint(repo.path, repo.base_branch));
  }
  return { branch, path };
}

export async function commitLeftovers(worktree: string, message: string): Promise<boolean> {
  if (!(await git(worktree, 'status', '--porcelain'))) return false;
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', message);
  return true;
}

export async function commitFiles(worktree: string, files: string[], message: string): Promise<void> {
  await git(worktree, 'add', '--', ...files);
  await git(worktree, 'commit', '-q', '-m', message, '--', ...files);
}

export type MergeOutcome = { kind: 'up_to_date' } | { kind: 'merged' } | { kind: 'conflicts'; files: string[] };

export const headCommit = (worktree: string) => git(worktree, 'rev-parse', 'HEAD');

export const mergeInProgress = (worktree: string) => refExists(worktree, 'MERGE_HEAD');

export async function conflictedFiles(worktree: string): Promise<string[]> {
  return (await git(worktree, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
}

export async function mergeRef(worktree: string, ref: string): Promise<MergeOutcome> {
  const before = await headCommit(worktree);
  try {
    await git(worktree, 'merge', '--no-edit', ref);
  } catch (err) {
    if (await mergeInProgress(worktree)) {
      const files = await conflictedFiles(worktree);
      if (files.length) return { kind: 'conflicts', files };
    }
    throw err;
  }
  return (await headCommit(worktree)) === before ? { kind: 'up_to_date' } : { kind: 'merged' };
}

export async function abortMerge(worktree: string, head: string): Promise<void> {
  if (await mergeInProgress(worktree)) await git(worktree, 'merge', '--abort');
  if ((await headCommit(worktree)) !== head) await git(worktree, 'reset', '--hard', head);
  await git(worktree, 'clean', '-fd');
}

export function filesWithMarkers(worktree: string, files: string[]): string[] {
  return files.filter((file) => {
    const path = join(worktree, file);
    return existsSync(path) && /^(<{7}|>{7})( |$)/m.test(readFileSync(path, 'latin1'));
  });
}

export async function concludeMerge(worktree: string): Promise<boolean> {
  if (!(await mergeInProgress(worktree))) return false;
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '--no-edit');
  return true;
}

export async function mergeSides(worktree: string): Promise<{ ours: string[]; theirs: string[] }> {
  const subjects = async (range: string) =>
    (await git(worktree, 'log', '--no-color', '--format=%s', '-n', '40', range, '--')).split('\n').filter(Boolean);
  return { ours: await subjects('MERGE_HEAD..HEAD'), theirs: await subjects('HEAD..MERGE_HEAD') };
}

export async function addDetachedWorktree(repo: Pick<Repo, 'path'>, path: string, ref: string): Promise<void> {
  await git(repo.path, 'worktree', 'add', '--detach', path, ref);
}

export function makeTempDir(repo: Pick<Repo, 'name'>, prefix: string): { dir: string; worktree: string } {
  const parent = join(WORKTREE_DIR, repo.name);
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `${prefix}-`));
  return { dir, worktree: join(dir, 'wt') };
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function removeWorktree(repo: Repo, path: string): Promise<void> {
  await git(repo.path, 'worktree', 'remove', '--force', path);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (await branchExists(repoPath, branch)) await git(repoPath, 'branch', '-D', branch);
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, 'worktree', 'prune');
}
