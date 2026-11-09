// Adapter for local git: refs and history, what is checked out and which commits there are.
import { dirname } from 'node:path';
import { BASE_LOG_FORMAT, type BaseCommit, type Commit, LOG_FORMAT, parseBaseLog, parseLog } from '../../domain/work/index.ts';
import type { ReviewFacts } from '../../domain/operations/index.ts';
import { DIFF_FLAGS, git, gitRead, gitRemote } from './exec.ts';

/** How long fetching the base branch may take before a task starts from what is already there. */
const FETCH_TIMEOUT_MS = 60_000;

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

export const branchExists = (repoPath: string, branch: string) => refExists(repoPath, `refs/heads/${branch}`);

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

/** Commits on the task branch that are on neither the local base nor origin's copy of it (it may start from either). */
export async function commitsAhead(worktree: string, base: string): Promise<number> {
  const remote = `refs/remotes/origin/${base}`;
  const bases = (await refExists(worktree, remote)) ? [base, remote] : [base];
  return Number(await git(worktree, 'rev-list', '--count', 'HEAD', '--not', ...bases));
}

/** Commits on `branch` that origin's copy of it lacks, or null when origin has no copy (it was never pushed). */
export async function aheadOfRemote(worktree: string, branch: string): Promise<number | null> {
  const remote = `refs/remotes/origin/${branch}`;
  if (!(await refExists(worktree, remote))) return null;
  return Number(await git(worktree, 'rev-list', '--count', 'HEAD', '--not', remote));
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

/** The commit `ref` names, or null if there is none. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) || null;
  } catch {
    return null;
  }
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

/**
 * The commits on `commit`'s first-parent line made after `since` (ms, by committer date), newest first, each with the
 * paths it changed (a merge against its first parent). At most `limit` are listed; `count` counts them all.
 */
export async function commitsSince(
  repoPath: string,
  commit: string,
  since: number,
  limit: number,
): Promise<{ count: number; commits: BaseCommit[] }> {
  // The base as it was at `since`: the newest first-parent commit made by then, none when the line is younger.
  const from = (await git(repoPath, 'rev-list', '-1', '--first-parent', `--before=${gitDate(since)}`, commit)) || null;
  const range = from ? `${from}..${commit}` : commit;
  const [count, log] = await Promise.all([
    git(repoPath, 'rev-list', '--count', '--first-parent', range),
    gitRead(
      repoPath,
      '-c',
      'core.quotePath=false',
      'log',
      '--no-color',
      '--first-parent',
      '-m',
      '--name-only',
      '-z',
      `--max-count=${limit}`,
      `--format=${BASE_LOG_FORMAT}`,
      range,
      '--',
    ),
  ]);
  return { count: Number(count), commits: parseBaseLog(log) };
}

/** Commits reachable from `head` but not `base`, newest first. */
export async function commitsBetween(repoPath: string, base: string, head: string): Promise<Commit[]> {
  return parseLog(await gitRead(repoPath, 'log', '--no-color', `--format=${LOG_FORMAT}`, `${base}..${head}`, '--'));
}
