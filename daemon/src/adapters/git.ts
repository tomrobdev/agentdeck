// Adapter for local git: worktrees, branches and commits.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
} from '../domain/work/index.ts';
import { branchName } from '../domain/work/index.ts';
import type { ReviewFacts } from '../domain/operations/index.ts';
import type { Repo } from '../domain/repos/index.ts';
import type { Task } from '../domain/work/index.ts';

const exec = promisify(execFile);

/** How long fetching the base branch may take before a task starts from what is already there. */
const FETCH_TIMEOUT_MS = 60_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * A git command that talks to a remote. It must never wait for a person: the daemon runs without a
 * terminal, and a credential prompt would keep the task's slot forever. So prompts are off and it times out.
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

/** The branch, commit (whole and short) and subject checked out in `cwd`, or null when it is not a git checkout. Local only: no fetch. */
export async function headSummary(cwd: string): Promise<{ branch: string; sha: string; short: string; subject: string } | null> {
  try {
    const [line, branch] = await Promise.all([git(cwd, 'log', '-1', '--format=%H%x09%h%x09%s'), git(cwd, 'branch', '--show-current')]);
    const [sha, short = '', ...subject] = line.split('\t');
    return sha ? { branch: branch || 'detached', sha, short, subject: subject.join('\t') } : null;
  } catch {
    return null;
  }
}

/** The commit checked out in `cwd`, or null when it is not a git checkout. */
export async function checkoutCommit(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, 'rev-parse', 'HEAD')) || null;
  } catch {
    return null;
  }
}

/** How many commits `cwd`'s HEAD has that `commit` does not, or null when either is unknown there. */
export async function commitsAheadOf(cwd: string, commit: string): Promise<number | null> {
  try {
    return Number(await git(cwd, 'rev-list', '--count', `${commit}..HEAD`));
  } catch {
    return null;
  }
}

/** Whether `file` (absolute) differs from HEAD in the checkout containing it: modified, staged or untracked. */
export async function hasUncommittedChanges(file: string): Promise<boolean> {
  try {
    return (await git(dirname(file), 'status', '--porcelain', '--', file)) !== '';
  } catch {
    return false;
  }
}

/** The branch checked out in `cwd`: 'detached' for a detached HEAD, null when it is not a git checkout. */
export async function checkedOutBranch(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, 'branch', '--show-current')) || 'detached';
  } catch {
    return null;
  }
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

/** The commit a local branch is at, or null if there is no such branch. */
export const branchCommit = (repoPath: string, branch: string) => resolveCommit(repoPath, `refs/heads/${branch}`);

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
    await gitRemote(repoPath, FETCH_TIMEOUT_MS, 'fetch', '--quiet', 'origin', base);
  } catch {
    // offline or the base isn't on origin: use what we have
  }
  return localStartPoint(repoPath, base);
}

/** What startPoint would pick, without fetching: origin's copy of the base when the repo has one, else the local base. */
export async function localStartPoint(repoPath: string, base: string): Promise<string> {
  if (!(await hasOrigin(repoPath))) return base;
  return (await refExists(repoPath, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

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

/** Commits on the task branch that are on neither the local base nor origin's copy of it (it may start from either). */
export async function commitsAhead(worktree: string, base: string): Promise<number> {
  const remote = `refs/remotes/origin/${base}`;
  const bases = (await refExists(worktree, remote)) ? [base, remote] : [base];
  return Number(await git(worktree, 'rev-list', '--count', 'HEAD', '--not', ...bases));
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

/** Commits on `branch` that origin's copy of it lacks, or null when origin has no copy (it was never pushed). */
export async function aheadOfRemote(worktree: string, branch: string): Promise<number | null> {
  const remote = `refs/remotes/origin/${branch}`;
  if (!(await refExists(worktree, remote))) return null;
  return Number(await git(worktree, 'rev-list', '--count', 'HEAD', '--not', remote));
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
  const candidates = await Promise.all(
    [
      { ref: base, full: `refs/heads/${base}` },
      { ref: `origin/${base}`, full: `refs/remotes/origin/${base}` },
    ].map(async ({ ref, full }) => {
      const tip = await resolveCommit(repoPath, full);
      const sha = tip && (await mergeBase(repoPath, tip, head));
      return sha ? { ref, sha } : null;
    }),
  );
  const [local, remote] = candidates;
  if (!local || !remote) return local ?? remote;
  if (local.sha === remote.sha) return local;
  return (await isAncestor(repoPath, local.sha, remote.sha)) ? remote : local;
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

/** The empty tree, what a diff of a repo's whole history starts from. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A time (ms since the epoch) as a date git reads exactly, in UTC. */
const gitDate = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)} +0000`;

/**
 * The repo's area review marks (refs/reviewed/<area>, the review-area skill's), and the commits and lines (added plus
 * deleted) merged into the base since the oldest one; with no mark, since `since` (ms), the base as it was then. The
 * base is origin's copy when there is one, else the local one; nothing is fetched. Null when there is no base.
 */
export async function reviewFacts(repoPath: string, base: string, since: number): Promise<ReviewFacts | null> {
  const tip = await resolveCommit(repoPath, await localStartPoint(repoPath, base));
  if (!tip) return null;
  // refs/reviewed/* has no reflog, so a mark's age is the commit date of the commit it points at: the base as reviewed.
  const listed = await git(
    repoPath,
    'for-each-ref',
    '--format=%(refname:lstrip=2)%09%(objectname)%09%(committerdate:unix)',
    'refs/reviewed/',
  );
  const marks = listed
    .split('\n')
    .map((line) => line.split('\t'))
    .map(([area, sha, at]) => ({ area, sha, at: Number(at) * 1000 }))
    .filter((m) => m.area && m.at > 0);
  const oldest = marks.reduce<(typeof marks)[number] | null>((o, m) => (!o || m.at < o.at ? m : o), null);
  const from = oldest?.sha ?? ((await git(repoPath, 'rev-list', '-1', `--before=${gitDate(since)}`, tip)) || null);
  const [count, stat] = await Promise.all([
    git(repoPath, 'rev-list', '--count', from ? `${from}..${tip}` : tip),
    gitRead(repoPath, 'diff', ...DIFF_FLAGS, '--shortstat', from ?? EMPTY_TREE, tip, '--'),
  ]);
  const lines = [...stat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return { marks: marks.map(({ area, at }) => ({ area, at })), commits: Number(count), lines };
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

/** Every file path at `commit`, repo-relative. */
export async function listFiles(repoPath: string, commit: string): Promise<string[]> {
  return (await gitRead(repoPath, 'ls-tree', '-r', '--name-only', '-z', commit)).split('\0').filter(Boolean);
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
