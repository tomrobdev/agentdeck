import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WORKTREE_DIR } from './config.ts';
import type { Repo, Task } from './db.ts';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, 'rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}

const branchExists = (repoPath: string, branch: string) => refExists(repoPath, `refs/heads/${branch}`);

export async function hasOrigin(repoPath: string): Promise<boolean> {
  return (await git(repoPath, 'remote')).split('\n').includes('origin');
}

/**
 * Where a new task branch starts: origin's copy of the base when the repo has one (fetched first,
 * so tasks don't build on a stale local base), otherwise the local base. A failed fetch (offline)
 * falls back to whatever origin ref is already there.
 */
export async function startPoint(repoPath: string, base: string): Promise<string> {
  if (!(await hasOrigin(repoPath))) return base;
  try {
    await git(repoPath, 'fetch', '--quiet', 'origin', base);
  } catch {
    // offline or the base isn't on origin: use what we have
  }
  return (await refExists(repoPath, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
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
    // --no-track: the task branch is local work, it shouldn't follow origin's base.
    await git(repo.path, 'worktree', 'add', '--no-track', '-b', branch, path, await startPoint(repo.path, repo.base_branch));
  }
  return { branch, path };
}

/** What toolchain detection looks at: the names in a repo's root directory and its package.json script names. */
export function rootInfo(dir: string): { files: string[]; scripts: string[] } {
  const files = readdirSync(dir);
  let scripts: string[] = [];
  if (files.includes('package.json')) {
    try {
      scripts = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {});
    } catch {
      // unreadable package.json: no scripts
    }
  }
  return { files, scripts };
}

/** Commit anything the agent left uncommitted, so the branch holds all its work. */
export async function commitLeftovers(worktree: string, message: string): Promise<boolean> {
  if (!(await git(worktree, 'status', '--porcelain'))) return false;
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-q', '-m', message);
  return true;
}

/** Commits on the task branch that are on neither the local base nor origin's copy of it (it may start from either). */
export async function commitsAhead(worktree: string, base: string): Promise<number> {
  const remote = `refs/remotes/origin/${base}`;
  const bases = (await refExists(worktree, remote)) ? [base, remote] : [base];
  return Number(await git(worktree, 'rev-list', '--count', 'HEAD', '--not', ...bases));
}

/** A throwaway checkout of `ref` with no branch of its own, for checks that must not leave anything behind. */
export async function addDetachedWorktree(repo: Pick<Repo, 'path'>, path: string, ref: string): Promise<void> {
  await git(repo.path, 'worktree', 'add', '--detach', path, ref);
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
