// Adapter for local git: diffs and compares, and reading trees and files at a commit.
import { PATCH_LIMIT, type ChangedFile, type TreeEntry, capText, mergeChanges, parseLsTree, treeEntries } from '../../domain/work/index.ts';
import { DIFF_FLAGS, READ_ENV, exec, git, gitCapped, gitRead, gitWithInput } from './exec.ts';
import { resolveCommit } from './refs.ts';

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

/**
 * Who makes mergeCommit's commits, at a fixed time, so the same merge is always the same commit and needs no git identity.
 * The commits are on no ref: git's gc removes them in time.
 */
const MERGE_ENV = {
  ...READ_ENV,
  GIT_AUTHOR_NAME: 'AgentDeck',
  GIT_AUTHOR_EMAIL: 'agentdeck@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'AgentDeck',
  GIT_COMMITTER_EMAIL: 'agentdeck@localhost',
  GIT_COMMITTER_DATE: '@0 +0000',
};

/**
 * `ours` and `theirs` merged, as a commit with both as parents, made from git objects alone (`git merge-tree --write-tree`,
 * then `commit-tree`): no checkout or ref changes. `ours` itself when it already has `theirs`. Null when they conflict.
 */
export async function mergeCommit(repoPath: string, ours: string, theirs: string): Promise<string | null> {
  if (await isAncestor(repoPath, theirs, ours)) return ours;
  let tree: string;
  try {
    const { stdout } = await exec('git', ['merge-tree', '--write-tree', '--no-messages', ours, theirs], { cwd: repoPath, env: MERGE_ENV });
    tree = stdout.split('\n')[0].trim();
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return null; // conflicts
    throw err;
  }
  const { stdout } = await exec('git', ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', 'Merge for a diff'], {
    cwd: repoPath,
    env: MERGE_ENV,
  });
  return stdout.trim();
}

/**
 * The patch-id of `head`'s changes against the base: `git patch-id --stable` of the diff from where `head` left the base
 * (`diffBase`) to `head`. It ignores line numbers and whitespace, so the same changes on a branch that has since brought
 * in the base keep their id. Null when there is no base to diff against or nothing changed. Doesn't fetch.
 */
export async function diffHash(repoPath: string, base: string, head: string): Promise<string | null> {
  const from = await diffBase(repoPath, base, head);
  if (!from) return null;
  const diff = await gitRead(repoPath, 'diff', ...DIFF_FLAGS, '--binary', from.sha, head, '--');
  if (!diff.trim()) return null;
  return (await gitWithInput(repoPath, diff, ['patch-id', '--stable'])).trim().split(/\s+/)[0] || null;
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
