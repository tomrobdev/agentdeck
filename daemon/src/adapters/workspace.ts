// Adapter for the Workspace port (application/ports/workspace.ts): git, the shell and a worktree's files, grouped into the
// operations the use cases need, on git.ts, shell.ts, plan-file.ts, protected-edits.ts and repo-root.ts.
import type { Repo } from '../domain/repos/index.ts';
import { errorMessage } from '../domain/shared/index.ts';
import type { Task } from '../domain/work/index.ts';
import {
  abortMerge,
  addDetachedWorktree,
  aheadOfRemote,
  branchCommit,
  changedFiles,
  checkedOutBranch,
  commitFiles,
  commitLeftovers,
  commitsAhead,
  commitsBetween,
  concludeMerge,
  conflictedFiles,
  currentBranch,
  deleteBranch,
  diffBase,
  diffHash,
  ensureWorktree,
  filePatch,
  filesWithMarkers,
  hasOrigin,
  headCommit,
  headSummary,
  isGitRepo,
  listFiles,
  listTree,
  localStartPoint,
  makeTempDir,
  mergeInProgress,
  mergeRef,
  mergeSides,
  objectAt,
  pruneWorktrees,
  readFile,
  refExists,
  removeTempDir,
  removeWorktree,
  resolveCommit,
  startPoint,
} from './git.ts';
import { readGivenPlan, readPlanFile, writeGivenPlan, writePlanFile } from './plan-file.ts';
import { applyProtectedEdits } from './protected-edits.ts';
import { rootInfo } from './repo-root.ts';
import { runCommand, runProgram } from './shell.ts';

/** Run `step` after a merge started at `before`; if it throws, put the branch back first. */
async function orUndo<T>(worktree: string, before: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    await abortMerge(worktree, before).catch(() => {});
    throw err;
  }
}

export const workspace = {
  prepareCheckout: (repo: Repo, task: Task) => ensureWorktree(repo, task),

  async removeCheckout(repo: Repo, checkout: { worktree?: string | null; branch?: string | null }): Promise<void> {
    if (checkout.worktree) await removeWorktree(repo, checkout.worktree);
    if (checkout.branch) await deleteBranch(repo.path, checkout.branch);
    await pruneWorktrees(repo.path).catch(() => {}); // the repo's folder may be gone; nothing to prune then
  },

  async withScratchCheckout<T>(repo: Repo, use: (checkout: { path: string } | { error: string }) => Promise<T>): Promise<T> {
    const tmp = makeTempDir(repo, 'scratch');
    let made = false;
    try {
      try {
        await addDetachedWorktree(repo, tmp.worktree, await startPoint(repo.path, repo.base_branch));
        made = true;
      } catch (err) {
        return await use({ error: errorMessage(err) });
      }
      return await use({ path: tmp.worktree });
    } finally {
      if (made) await removeWorktree(repo, tmp.worktree).catch(() => {});
      removeTempDir(tmp.dir);
      await pruneWorktrees(repo.path).catch(() => {});
    }
  },

  async inspectRepo(path: string, base?: string): Promise<{ branch: string; origin: boolean; base: string | null } | null> {
    if (!(await isGitRepo(path))) return null;
    const has = (ref: string) => (base ? refExists(path, ref) : Promise.resolve(false));
    const [branch, origin, local, remote] = await Promise.all([
      // A repo with no commits yet has no HEAD to name, only the branch it is on.
      currentBranch(path).catch(async () => (await checkedOutBranch(path)) ?? 'HEAD'),
      hasOrigin(path),
      has(`refs/heads/${base}`),
      has(`refs/remotes/origin/${base}`),
    ]);
    return { branch, origin, base: local ? base! : remote ? `origin/${base}` : null };
  },

  rootInfo: async (dir: string) => rootInfo(dir),

  head: (cwd: string) => headSummary(cwd),

  commitsAhead: (cwd: string, base: string) => commitsAhead(cwd, base),

  unpushedCommits: (worktree: string, branch: string) => aheadOfRemote(worktree, branch),

  runCommand: (command: string | string[], cwd: string, timeoutMs: number) =>
    typeof command === 'string' ? runCommand(command, cwd, timeoutMs) : runProgram(command[0], command.slice(1), cwd, timeoutMs),

  async commit(worktree: string, message: string, only?: string[]): Promise<boolean> {
    if (!only) return commitLeftovers(worktree, message);
    if (!only.length) return false;
    await commitFiles(worktree, only, message);
    return true;
  },

  applyProtectedEdits: (worktree: string) => applyProtectedEdits(worktree),

  async startSync(repo: Repo, worktree: string, leftovers: string) {
    // A merge left half done by a crash would otherwise be committed with its markers.
    if (await mergeInProgress(worktree)) await abortMerge(worktree, await headCommit(worktree));
    await commitLeftovers(worktree, leftovers);
    const ref = await startPoint(repo.path, repo.base_branch);
    if (!(await refExists(worktree, ref))) return { kind: 'no_base' as const, ref };
    const before = await headCommit(worktree);
    return orUndo(worktree, before, async () => {
      const merge = await mergeRef(worktree, ref);
      if (merge.kind === 'up_to_date') return merge;
      if (merge.kind === 'merged') return { kind: 'merged' as const, before };
      return { kind: 'conflicts' as const, before, files: merge.files, ...(await mergeSides(worktree)) };
    });
  },

  async finishSync(worktree: string, files: string[], before: string, leftovers: string) {
    const marked = filesWithMarkers(worktree, files);
    if (marked.length) return { kind: 'markers' as const, files: marked };
    await concludeMerge(worktree);
    await commitLeftovers(worktree, leftovers);
    if ((await mergeInProgress(worktree)) || (await conflictedFiles(worktree)).length) return { kind: 'unfinished' as const };
    if ((await headCommit(worktree)) === before) return { kind: 'not_committed' as const };
    return { kind: 'done' as const };
  },

  undoSync: (worktree: string, before: string) => abortMerge(worktree, before),

  writePlanFile: (worktree: string, html: string | null) => writePlanFile(worktree, html),

  async readPlanFiles(worktree: string): Promise<{ written: string | null; given: string | null }> {
    const [written, given] = await Promise.all([readPlanFile(worktree), readGivenPlan(worktree)]);
    return { written, given };
  },

  writeGivenPlan: (worktree: string, html: string | null) => writeGivenPlan(worktree, html),

  branchHead: (repoPath: string, branch: string) => branchCommit(repoPath, branch),

  diffBase: (repoPath: string, base: string, head: string) => diffBase(repoPath, base, head),

  async diffHash(repoPath: string, base: string, head: string) {
    try {
      return await diffHash(repoPath, base, head);
    } catch {
      return null; // no such commit, or git refused: the review is stored without it
    }
  },

  async compare(repoPath: string, base: string, head: string) {
    const [files, commits] = await Promise.all([changedFiles(repoPath, base, head), commitsBetween(repoPath, base, head)]);
    return { files, commits };
  },

  filePatch: (repoPath: string, base: string, head: string, paths: string[]) => filePatch(repoPath, base, head, paths),

  async listTree(repoPath: string, commit: string, dir: string) {
    if ((await objectAt(repoPath, commit, dir))?.type !== 'tree') return null;
    return listTree(repoPath, commit, dir);
  },

  readFile: (repoPath: string, commit: string, path: string, limit: number) => readFile(repoPath, commit, path, limit),

  async filesAt(repoPath: string, at: { base: string } | { branch: string }): Promise<{ ref: string; files: string[] } | null> {
    const ref = 'base' in at ? await localStartPoint(repoPath, at.base) : at.branch;
    const commit = 'base' in at ? await resolveCommit(repoPath, ref) : await branchCommit(repoPath, at.branch);
    return commit ? { ref, files: await listFiles(repoPath, commit) } : null;
  },
};
