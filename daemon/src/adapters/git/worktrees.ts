// Adapter for local git: worktrees, and committing and merging in them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKTREE_DIR } from '../../config.ts';
import { branchName } from '../../domain/work/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { git } from './exec.ts';
import { branchExists, refExists, startPoint } from './refs.ts';

/**
 * Give the task its own worktree on its own branch. Retries reuse the same
 * worktree and branch, so a second attempt builds on the first.
 */
export async function ensureWorktree(repo: Repo, task: Task): Promise<{ branch: string; path: string }> {
  const branch = branchName(task);
  const path = task.checkout?.worktree ?? join(WORKTREE_DIR, repo.name, `task-${task.id}`);
  if (existsSync(path)) return { branch, path };

  mkdirSync(dirname(path), { recursive: true });
  await git(repo.path, 'worktree', 'prune');
  if (await branchExists(repo.path, branch)) {
    await git(repo.path, 'worktree', 'add', path, branch);
  } else {
    // --no-track: the task branch is local work, it shouldn't follow origin's base.
    await git(repo.path, 'worktree', 'add', '--no-track', '-b', branch, path, await startPoint(repo.path, repo.base_branch));
  }
  return { branch, path };
}

/** Commit anything the agent left uncommitted, so the branch holds all its work. */
export async function commitLeftovers(worktree: string, message: string): Promise<boolean> {
  if (!(await git(worktree, 'status', '--porcelain'))) return false;
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', message);
  return true;
}

/** Stage `files` and commit just them. */
export async function commitFiles(worktree: string, files: string[], message: string): Promise<void> {
  await git(worktree, 'add', '--', ...files);
  await git(worktree, 'commit', '-q', '-m', message, '--', ...files);
}

// Syncing a task's branch with the base branch. Always a merge, never a rebase: no force pushes, and the
// squash merge of the PR hides the merge commit anyway.

/** What merging a ref into a worktree did. */
export type MergeOutcome = { kind: 'up_to_date' } | { kind: 'merged' } | { kind: 'conflicts'; files: string[] };

export const headCommit = (worktree: string) => git(worktree, 'rev-parse', 'HEAD');

/** A merge has stopped and is waiting to be committed or aborted. */
export const mergeInProgress = (worktree: string) => refExists(worktree, 'MERGE_HEAD');

/** Files with unresolved conflicts, as git sees them. */
export async function conflictedFiles(worktree: string): Promise<string[]> {
  return (await git(worktree, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
}

/**
 * `git merge <ref>` in the worktree. A clean merge is committed by git. On conflicts the merge is left
 * in progress, markers and all, for a resolve run (or `abortMerge`). Any other failure throws.
 */
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

/**
 * Undo a merge: abort it if it is in progress, and put the branch back at `head` if it moved. Untracked
 * files go too (what a resolve run or the tests left), so they are never committed onto the branch later;
 * ignored files stay. Safe because leftovers are committed before every merge.
 */
export async function abortMerge(worktree: string, head: string): Promise<void> {
  if (await mergeInProgress(worktree)) await git(worktree, 'merge', '--abort');
  if ((await headCommit(worktree)) !== head) await git(worktree, 'reset', '--hard', head);
  await git(worktree, 'clean', '-fd');
}

/** Of `files`, those that still hold conflict markers in the worktree. */
export function filesWithMarkers(worktree: string, files: string[]): string[] {
  return files.filter((file) => {
    const path = join(worktree, file);
    return existsSync(path) && /^(<{7}|>{7})( |$)/m.test(readFileSync(path, 'latin1'));
  });
}

/** Commit a merge the agent staged but did not commit. Returns false if none was waiting. */
export async function concludeMerge(worktree: string): Promise<boolean> {
  if (!(await mergeInProgress(worktree))) return false;
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '--no-edit');
  return true;
}

/** While a merge is in progress: subjects of the commits only the task's branch has, and only the other side has. */
export async function mergeSides(worktree: string): Promise<{ ours: string[]; theirs: string[] }> {
  const subjects = async (range: string) =>
    (await git(worktree, 'log', '--no-color', '--format=%s', '-n', '40', range, '--')).split('\n').filter(Boolean);
  return { ours: await subjects('MERGE_HEAD..HEAD'), theirs: await subjects('HEAD..MERGE_HEAD') };
}

/** A throwaway checkout of `ref` with no branch of its own, for checks that must not leave anything behind. */
export async function addDetachedWorktree(repo: Pick<Repo, 'path'>, path: string, ref: string): Promise<void> {
  await git(repo.path, 'worktree', 'add', '--detach', path, ref);
}

/** A fresh directory under the daemon's own worktree dir, and the path inside it for a temporary worktree. Remove it with `removeTempDir`. */
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

/** Delete a local branch, even unmerged. A branch that is already gone is fine. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (await branchExists(repoPath, branch)) await git(repoPath, 'branch', '-D', branch);
}

/** Drop the records of worktrees whose folders are gone. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, 'worktree', 'prune');
}
