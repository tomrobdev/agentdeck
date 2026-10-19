// Adapter for local git: worktrees, branches and commits.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WORKTREE_DIR } from '../config.ts';
import {
  type ChangedFile,
  type Commit,
  LOG_FORMAT,
  PATCH_LIMIT,
  type TreeEntry,
  capText,
  mergeChanges,
  parseLog,
  parseLsTree,
  treeEntries,
} from '../domain/files/files.ts';
import type { Repo } from '../domain/repo/repo.ts';
import type { Task } from '../domain/task/task.ts';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * A git command that talks to a remote. It must never wait for a person: the daemon runs without a
 * terminal, and a credential prompt would hold the task's slot forever. So prompts are off and it times out.
 */
export async function gitRemote(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
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

// Reading commits, trees and files. These read git objects only, never a worktree's files, so they
// work after the worktree is gone and never show uncommitted work. Paths come after `--` and are
// taken literally (no pathspec magic such as `:(top)` or globs).

const READ_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
// Diffs look the same whatever the person's git config says.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

/** Like `git`, for reads: untrimmed output and literal pathspecs. */
async function gitRead(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: READ_ENV });
  return stdout;
}

/** Run git and keep at most `limit` bytes of its output, stopping it once there is more. */
function gitCapped(cwd: string, limit: number, args: string[]): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: READ_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      if (truncated) return;
      chunks.push(c);
      size += c.length;
      if (size > limit) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !truncated) return reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
      const all = Buffer.concat(chunks);
      resolve({ bytes: truncated ? all.subarray(0, limit + 1) : all, truncated });
    });
  });
}

/** The commit `ref` names, or null if there is none. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) || null;
  } catch {
    return null;
  }
}

async function mergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(repoPath, 'merge-base', a, b)) || null;
  } catch {
    return null; // no common history
  }
}

async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean> {
  try {
    await git(repoPath, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `head` left the base branch: its merge base with the local base and with origin's copy,
 * whichever is newer (a task branch starts from either, see startPoint). Doesn't fetch.
 * Null when neither base ref exists or shares history with `head`.
 */
export async function diffBase(repoPath: string, base: string, head: string): Promise<{ ref: string; sha: string } | null> {
  let best: { ref: string; sha: string } | null = null;
  for (const ref of [base, `origin/${base}`]) {
    const tip = await resolveCommit(repoPath, ref === base ? `refs/heads/${base}` : `refs/remotes/${ref}`);
    const sha = tip && (await mergeBase(repoPath, tip, head));
    if (!sha) continue;
    if (!best || (best.sha !== sha && (await isAncestor(repoPath, best.sha, sha)))) best = { ref, sha };
  }
  return best;
}

/** Files changed between two commits, renames detected. */
export async function changedFiles(repoPath: string, base: string, head: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    gitRead(repoPath, 'diff', ...DIFF_FLAGS, '-M', '-z', '--name-status', base, head, '--'),
    gitRead(repoPath, 'diff', ...DIFF_FLAGS, '-M', '-z', '--numstat', base, head, '--'),
  ]);
  return mergeChanges(nameStatus, numstat);
}

/** The unified diff of one file between two commits. Pass both paths of a rename so git pairs them. */
export async function filePatch(
  repoPath: string,
  base: string,
  head: string,
  paths: string[],
): Promise<{ patch: string; truncated: boolean }> {
  const { bytes } = await gitCapped(repoPath, PATCH_LIMIT, ['diff', ...DIFF_FLAGS, '-M', base, head, '--', ...paths]);
  const { text, truncated } = capText(bytes, PATCH_LIMIT, { wholeLines: true });
  return { patch: text, truncated };
}

/** Commits reachable from `head` but not `base`, newest first. */
export async function commitsBetween(repoPath: string, base: string, head: string): Promise<Commit[]> {
  return parseLog(await gitRead(repoPath, 'log', '--no-color', `--format=${LOG_FORMAT}`, `${base}..${head}`, '--'));
}

/** What `path` is at `commit`: a blob (file) or tree (folder), or null if nothing is there. '' is the root. */
export async function objectAt(
  repoPath: string,
  commit: string,
  path: string,
): Promise<{ type: 'blob' | 'tree'; size: number | null } | null> {
  if (!path) return { type: 'tree', size: null };
  const [entry] = parseLsTree(await gitRead(repoPath, 'ls-tree', '-l', '-z', commit, '--', path));
  return entry && entry.path === path ? { type: entry.type, size: entry.size } : null;
}

/** One level of the folder `dir` ('' for the root) at `commit`: folders first, then by name. */
export async function listTree(repoPath: string, commit: string, dir: string): Promise<TreeEntry[]> {
  return treeEntries(await gitRead(repoPath, 'ls-tree', '-l', '-z', commit, '--', ...(dir ? [`${dir}/`] : [])));
}

/** The file at `path` in `commit`, at most `limit` bytes of it, or null if no file is there. */
export async function readFile(
  repoPath: string,
  commit: string,
  path: string,
  limit: number,
): Promise<{ size: number; bytes: Buffer; truncated: boolean } | null> {
  const obj = await objectAt(repoPath, commit, path);
  if (obj?.type !== 'blob') return null;
  const { bytes, truncated } = await gitCapped(repoPath, limit, ['cat-file', 'blob', `${commit}:${path}`]);
  return { size: obj.size ?? bytes.length, bytes, truncated };
}
