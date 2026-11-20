// Adapter for the Workspace port (application/ports/workspace.ts): git, the shell and a worktree's files, grouped into the operations the use cases need, on git.ts, shell.ts, plan-file.ts, protected-edits.ts and repo-root.ts.
import type { Repo } from '#domain/repos/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import type { Task } from '#domain/work/index.ts';
import {
  abortMerge,
  addDetachedWorktree,
  commitFiles,
  commitLeftovers,
  concludeMerge,
  conflictedFiles,
  cutBranch,
  deleteBranch,
  ensureWorktree,
  filesWithMarkers,
  headCommit,
  makeTempDir,
  mergeInProgress,
  mergeRef,
  mergeSides,
  moveBranch,
  pruneWorktrees,
  removeTempDir,
  removeWorktree,
  revertChange,
  takeTheirs,
} from '#adapters/git/worktrees.ts';
import {
  aheadBehind,
  aheadOfRemote,
  branchCommit,
  checkedOutBranch,
  commitsAhead,
  commitsBetween,
  commitsSince,
  currentBranch,
  hasOrigin,
  headSummary,
  isGitRepo,
  localStartPoint,
  refExists,
  resolveCommit,
  reviewFacts,
  startPoint,
} from '#adapters/git/refs.ts';
import {
  addedLines,
  changedFiles,
  diffBase,
  diffHash,
  filePatch,
  listFiles,
  listTree,
  mergeCommit,
  objectAt,
  readFile,
} from '#adapters/git/diffs.ts';
import { readGivenPlan, readPlanFile, writeGivenPlan, writePlanFile } from '#adapters/local/plan-file.ts';
import { applyProtectedEdits } from '#adapters/local/protected-edits.ts';
import { rootInfo } from '#adapters/git/repo-root.ts';
import { runCommand, runProgram } from '#adapters/process/shell.ts';

async function orUndo<T>(worktree: string, before: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    await abortMerge(worktree, before).catch(() => {});
    throw err;
  }
}

export const workspace = {
  prepareCheckout: (repo: Repo, task: Task, target: string) => ensureWorktree(repo, task, target),

  cutBranch: (repoPath: string, branch: string, from: string) => cutBranch(repoPath, branch, from),

  moveBranch: (repoPath: string, branch: string, sha: string) => moveBranch(repoPath, branch, sha),

  revertChange: (worktree: string, branch: string, change: { from: string; to: string; message: string }) =>
    revertChange(worktree, branch, change),

  async removeCheckout(repo: Repo, checkout: { worktree?: string | null; branch?: string | null }): Promise<void> {
    if (checkout.worktree) await removeWorktree(repo, checkout.worktree);
    if (checkout.branch) await deleteBranch(repo.path, checkout.branch);
    await pruneWorktrees(repo.path).catch(() => {});
  },

  async withScratchCheckout<T>(
    repo: Repo,
    branch: string,
    use: (checkout: { path: string } | { error: string }) => Promise<T>,
  ): Promise<T> {
    const tmp = makeTempDir(repo, 'scratch');
    let made = false;
    try {
      try {
        await addDetachedWorktree(repo, tmp.worktree, await startPoint(repo.path, branch));
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
      currentBranch(path).catch(async () => (await checkedOutBranch(path)) ?? 'HEAD'),
      hasOrigin(path),
      has(`refs/heads/${base}`),
      has(`refs/remotes/origin/${base}`),
    ]);
    return { branch, origin, base: local && base ? base : remote ? `origin/${base}` : null };
  },

  rootInfo: async (dir: string) => rootInfo(dir),

  head: (cwd: string) => headSummary(cwd),

  commitsAhead: (cwd: string, base: string) => commitsAhead(cwd, base),

  unpushedCommits: (worktree: string, branch: string) => aheadOfRemote(worktree, branch),

  aheadBehind: (repoPath: string, base: string, branch: string) => aheadBehind(repoPath, base, branch),

  reviewFacts: (repoPath: string, base: string, since: number) => reviewFacts(repoPath, base, since),

  runCommand: (command: string | string[], cwd: string, timeoutMs: number) =>
    typeof command === 'string' ? runCommand(command, cwd, timeoutMs) : runProgram(command[0], command.slice(1), cwd, timeoutMs),

  async commit(worktree: string, message: string, only?: string[]): Promise<boolean> {
    if (!only) return commitLeftovers(worktree, message);
    if (!only.length) return false;
    await commitFiles(worktree, only, message);
    return true;
  },

  applyProtectedEdits: (worktree: string) => applyProtectedEdits(worktree),

  async startSync(repo: Repo, target: string, worktree: string, leftovers: string) {
    if (await mergeInProgress(worktree)) await abortMerge(worktree, await headCommit(worktree));
    await commitLeftovers(worktree, leftovers);
    const ref = await startPoint(repo.path, target);
    if (!(await refExists(worktree, ref))) return { kind: 'no_base' as const, ref };
    const before = await headCommit(worktree);
    return orUndo(worktree, before, async () => {
      const merge = await mergeRef(worktree, ref, repo.union_paths);
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

  takeBaseSide: (worktree: string, files: string[]) => takeTheirs(worktree, files),

  undoSync: (worktree: string, before: string) => abortMerge(worktree, before),

  writePlanFile: (worktree: string, html: string | null) => writePlanFile(worktree, html),

  async readPlanFiles(worktree: string): Promise<{ written: string | null; given: string | null }> {
    const [written, given] = await Promise.all([readPlanFile(worktree), readGivenPlan(worktree)]);
    return { written, given };
  },

  writeGivenPlan: (worktree: string, html: string | null) => writeGivenPlan(worktree, html),

  branchHead: (repoPath: string, branch: string) => branchCommit(repoPath, branch),

  onOrigin: (repoPath: string, branch: string) => refExists(repoPath, `refs/remotes/origin/${branch}`),

  diffBase: (repoPath: string, base: string, head: string) => diffBase(repoPath, base, head),

  async diffHash(repoPath: string, base: string, head: string) {
    try {
      return await diffHash(repoPath, base, head);
    } catch {
      return null;
    }
  },

  async compare(repoPath: string, base: string, head: string) {
    const [files, commits] = await Promise.all([changedFiles(repoPath, base, head), commitsBetween(repoPath, base, head)]);
    return { files, commits };
  },

  filePatch: (repoPath: string, base: string, head: string, paths: string[]) => filePatch(repoPath, base, head, paths),

  async addedLines(repoPath: string, base: string, head: string) {
    try {
      return await addedLines(repoPath, base, head);
    } catch {
      return null;
    }
  },

  mergeCommit: (repoPath: string, ours: string, theirs: string) => mergeCommit(repoPath, ours, theirs),

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

  async startCommit(repoPath: string, base: string): Promise<{ ref: string; sha: string } | null> {
    const ref = await localStartPoint(repoPath, base);
    const sha = await resolveCommit(repoPath, ref);
    return sha ? { ref, sha } : null;
  },

  commitsSince: (repoPath: string, commit: string, since: number, limit: number) => commitsSince(repoPath, commit, since, limit),
};
