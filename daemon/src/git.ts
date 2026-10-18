import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WORKTREE_DIR } from './config.ts';
import type { Repo, Task } from './db.ts';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

export function branchFor(task: Pick<Task, 'id'>): string {
  return `agentdeck/task-${task.id}`;
}

/**
 * Give the task its own worktree on its own branch. Retries reuse the same
 * worktree and branch, so a second attempt builds on the first.
 */
export async function ensureWorktree(repo: Repo, task: Task): Promise<{ branch: string; path: string }> {
  const branch = task.branch ?? branchFor(task);
  const path = task.worktree ?? join(WORKTREE_DIR, repo.name, `task-${task.id}`);
  if (existsSync(path)) return { branch, path };

  mkdirSync(dirname(path), { recursive: true });
  await git(repo.path, 'worktree', 'prune');
  if (await branchExists(repo.path, branch)) {
    await git(repo.path, 'worktree', 'add', path, branch);
  } else {
    await git(repo.path, 'worktree', 'add', '-b', branch, path, repo.base_branch);
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

export async function commitsAhead(worktree: string, base: string): Promise<number> {
  return Number(await git(worktree, 'rev-list', '--count', `${base}..HEAD`));
}

export async function removeWorktree(repo: Repo, path: string): Promise<void> {
  await git(repo.path, 'worktree', 'remove', '--force', path);
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(path: string): Promise<string> {
  return git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
}
