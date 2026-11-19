// Adapter for local git: refs and history, what is checked out and which commits there are.
import { dirname } from 'node:path';
import { BASE_LOG_FORMAT, type BaseCommit, type Commit, LOG_FORMAT, parseBaseLog, parseLog } from '#domain/work/index.ts';
import type { ReviewFacts } from '#domain/operations/index.ts';
import { DIFF_FLAGS, git, gitRead, gitRemote } from '#adapters/git/exec.ts';

const FETCH_TIMEOUT_MS = 60_000;

export async function headSummary(cwd: string): Promise<{ branch: string; sha: string; short: string; subject: string } | null> {
  try {
    const [line, branch] = await Promise.all([git(cwd, 'log', '-1', '--format=%H%x09%h%x09%s'), git(cwd, 'branch', '--show-current')]);
    const [sha, short = '', ...subject] = line.split('\t');
    return sha ? { branch: branch || 'detached', sha, short, subject: subject.join('\t') } : null;
  } catch {
    return null;
  }
}

export async function checkoutCommit(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, 'rev-parse', 'HEAD')) || null;
  } catch {
    return null;
  }
}

export async function commitsAheadOf(cwd: string, commit: string): Promise<number | null> {
  try {
    return Number(await git(cwd, 'rev-list', '--count', `${commit}..HEAD`));
  } catch {
    return null;
  }
}

export async function hasUncommittedChanges(file: string): Promise<boolean> {
  try {
    return (await git(dirname(file), 'status', '--porcelain', '--', file)) !== '';
  } catch {
    return false;
  }
}

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

export const branchCommit = (repoPath: string, branch: string) => resolveCommit(repoPath, `refs/heads/${branch}`);

export async function hasOrigin(repoPath: string): Promise<boolean> {
  return (await git(repoPath, 'remote')).split('\n').includes('origin');
}

export async function startPoint(repoPath: string, base: string): Promise<string> {
  if (!(await hasOrigin(repoPath))) return base;
  try {
    await gitRemote(repoPath, FETCH_TIMEOUT_MS, 'fetch', '--quiet', 'origin', base);
  } catch {}
  return localStartPoint(repoPath, base);
}

export async function localStartPoint(repoPath: string, base: string): Promise<string> {
  if (!(await hasOrigin(repoPath))) return base;
  return (await refExists(repoPath, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

export async function commitsAhead(worktree: string, base: string): Promise<number> {
  const remote = `refs/remotes/origin/${base}`;
  const bases = (await refExists(worktree, remote)) ? [base, remote] : [base];
  return Number(await git(worktree, 'rev-list', '--count', 'HEAD', '--not', ...bases));
}

export async function aheadBehind(repoPath: string, base: string, branch: string): Promise<{ ahead: number; behind: number } | null> {
  try {
    const counts = await git(
      repoPath,
      'rev-list',
      '--left-right',
      '--count',
      `${await localStartPoint(repoPath, base)}...refs/heads/${branch}`,
    );
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    return { ahead, behind };
  } catch {
    return null;
  }
}

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

export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) || null;
  } catch {
    return null;
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const gitDate = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)} +0000`;

export async function reviewFacts(repoPath: string, base: string, since: number): Promise<ReviewFacts | null> {
  const tip = await resolveCommit(repoPath, await localStartPoint(repoPath, base));
  if (!tip) return null;
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

export async function commitsSince(
  repoPath: string,
  commit: string,
  since: number,
  limit: number,
): Promise<{ count: number; commits: BaseCommit[] }> {
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

export async function commitsBetween(repoPath: string, base: string, head: string): Promise<Commit[]> {
  return parseLog(await gitRead(repoPath, 'log', '--no-color', `--format=${LOG_FORMAT}`, `${base}..${head}`, '--'));
}
