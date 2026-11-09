// The Workspace port: git, the shell and a worktree's files, in the operations the use cases need. The real adapter is
// adapters/git/workspace.ts (compose.ts); tests run it on real git in a temporary folder, with no fake.
import type { ReviewFacts } from '../../domain/operations/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import type { BaseCommit, ChangedFile, Commit, Task, TreeEntry } from '../../domain/work/index.ts';

/** A task's checkout: its branch and the worktree it is checked out in. */
export interface Checkout {
  branch: string;
  path: string;
}

/** What git says about a folder that is a git checkout. */
export interface RepoFacts {
  /** The branch checked out there. */
  branch: string;
  /** Whether it has an origin remote. */
  origin: boolean;
  /** Which copy of the base branch exists: the local one (`main`), else origin's (`origin/main`), else null. */
  base: string | null;
}

/** The checkout's HEAD. */
export interface Head {
  /** 'detached' for a detached HEAD. */
  branch: string;
  sha: string;
  short: string;
  subject: string;
}

/** What toolchain detection reads in a folder: the names in it and its package.json script names. */
export interface RootInfo {
  files: string[];
  scripts: string[];
}

/** What a command did. Never a throw: a failure or a timeout is `passed: false`. */
export interface CommandResult {
  passed: boolean;
  output: string;
}

/** What starting a sync did to the task's branch. `before` is the commit to undo the merge to. */
export type SyncStart =
  | { kind: 'no_base'; ref: string }
  | { kind: 'up_to_date' }
  | { kind: 'merged'; before: string }
  /** The merge waits in the worktree with its markers, for a resolve run; `ours` and `theirs` are the commit subjects of each side. */
  | { kind: 'conflicts'; before: string; files: string[]; ours: string[]; theirs: string[] };

/** What finishing a resolved merge found. */
export type SyncFinish = { kind: 'done' } | { kind: 'markers'; files: string[] } | { kind: 'unfinished' } | { kind: 'not_committed' };

/** What applying the protected edits did. */
export interface AppliedEdits {
  /** The files written and committed, from the repo root. */
  applied: string[];
  /** The edits left out, by their path in the edits folder, and why. */
  refused: { path: string; reason: string }[];
}

export interface Workspace {
  // Checkouts

  /** The task's worktree on its own branch, made from the base's start point if it is not there. Retries reuse it. */
  prepareCheckout(repo: Repo, task: Task): Promise<Checkout>;
  /** Remove a worktree, delete a local branch (even unmerged; a gone one is fine), or both, then prune git's records. */
  removeCheckout(repo: Repo, checkout: { worktree?: string | null; branch?: string | null }): Promise<void>;
  /**
   * A throwaway checkout of the base's start point with no branch of its own, for `use`, removed after it whatever
   * happens. `use` is given the error instead when the checkout could not be made.
   */
  withScratchCheckout<T>(repo: Repo, use: (checkout: { path: string } | { error: string }) => Promise<T>): Promise<T>;

  // What is there

  /** What git says about the folder, or null when it is not a git checkout. `base` names the base branch to look for. */
  inspectRepo(path: string, base?: string): Promise<RepoFacts | null>;
  /** What toolchain detection reads in `dir`. */
  rootInfo(dir: string): Promise<RootInfo>;
  /** The HEAD checked out in `cwd`, or null when it is not a git checkout. Local only: no fetch. */
  head(cwd: string): Promise<Head | null>;
  /** Commits `cwd`'s HEAD has that neither `base` (a branch or a commit) nor origin's copy of it has. */
  commitsAhead(cwd: string, base: string): Promise<number>;
  /** Commits on `branch` that origin's copy of it lacks, or null when it was never pushed. */
  unpushedCommits(worktree: string, branch: string): Promise<number | null>;
  /**
   * The repo's area review marks (refs/reviewed/*) and the commits and lines merged into the base since the oldest; with
   * no mark, since `since` (ms since the epoch). Origin's copy of the base when there is one; no fetch. Null with no base.
   */
  reviewFacts(repoPath: string, base: string, since: number): Promise<ReviewFacts | null>;

  // Changing a worktree

  /** Run a repo command in `cwd`: a string through the shell, or `[program, ...args]` without one. Its own process group. */
  runCommand(command: string | string[], cwd: string, timeoutMs: number): Promise<CommandResult>;
  /** Commit what is left uncommitted in the worktree, or only the files `only` names. Whether anything was committed. */
  commit(worktree: string, message: string, only?: string[]): Promise<boolean>;
  /** Copy the worker's protected edits to their places, commit them in one commit, and clear the edits folder. */
  applyProtectedEdits(worktree: string): Promise<AppliedEdits>;

  // Sync

  /**
   * Bring the base into the task's branch: undo a merge a crash left half done, commit leftovers with `leftovers`,
   * fetch, then merge origin's base (the local base without an origin). A clean merge is committed; on conflicts the merge
   * waits in the worktree. Anything else throws, with the branch put back.
   */
  startSync(repo: Repo, worktree: string, leftovers: string): Promise<SyncStart>;
  /** After a resolve run: check the conflicted `files` are settled, commit the merge and leftovers, and say what is still wrong. */
  finishSync(worktree: string, files: string[], before: string, leftovers: string): Promise<SyncFinish>;
  /** Undo a sync: abort the merge, put the branch back at `before`, and remove untracked files (ignored ones stay). */
  undoSync(worktree: string, before: string): Promise<void>;

  // The plan file

  /** Put the run's plan in the worktree's plan file and keep a copy as the plan it was given; null removes both. */
  writePlanFile(worktree: string, html: string | null): Promise<void>;
  /** The plan file the run left and the copy it was given, each null when missing or too big. */
  readPlanFiles(worktree: string): Promise<{ written: string | null; given: string | null }>;
  /** Record `html` as the plan the run was given, once it is stored. */
  writeGivenPlan(worktree: string, html: string | null): Promise<void>;

  // Reading code. These read git objects only, never a worktree's files, so they work in the repo's main checkout.

  /** The commit a local branch is at, or null if there is no such branch. */
  branchHead(repoPath: string, branch: string): Promise<string | null>;
  /** Where `head` left the base branch: its merge base with the local base or origin's copy, whichever is newer. */
  diffBase(repoPath: string, base: string, head: string): Promise<{ ref: string; sha: string } | null>;
  /**
   * The patch-id of `head`'s changes against the base (from where `head` left it, as `diffBase`): the same changes keep
   * their id after a sync that only brings in the base. Null when there is no base, nothing changed, or git can't tell.
   */
  diffHash(repoPath: string, base: string, head: string): Promise<string | null>;
  /** The files changed between two commits (renames detected) and the commits in between, newest first. */
  compare(repoPath: string, base: string, head: string): Promise<{ files: ChangedFile[]; commits: Commit[] }>;
  /** The unified diff of one file between two commits, cut at PATCH_LIMIT. Pass both paths of a rename. */
  filePatch(repoPath: string, base: string, head: string, paths: string[]): Promise<{ patch: string; truncated: boolean }>;
  /**
   * `ours` and `theirs` merged as a commit of their own, on no ref and with no checkout touched, for `compare` and `filePatch`
   * to diff from: `ours` itself when it already has `theirs`, null when they conflict.
   */
  mergeCommit(repoPath: string, ours: string, theirs: string): Promise<string | null>;
  /** One level of the folder `dir` ('' for the root) at `commit`, folders first; null when no folder is there. */
  listTree(repoPath: string, commit: string, dir: string): Promise<TreeEntry[] | null>;
  /** The file at `path` in `commit`, at most `limit` bytes of it, or null if no file is there. */
  readFile(
    repoPath: string,
    commit: string,
    path: string,
    limit: number,
  ): Promise<{ size: number; bytes: Buffer; truncated: boolean } | null>;
  /**
   * Every file path, repo-relative, at the commit a worker would start from (`{ base }`: origin's copy when there is one,
   * not fetched) or at a local branch; with the ref's name. Null when there is no such commit.
   */
  filesAt(repoPath: string, at: { base: string } | { branch: string }): Promise<{ ref: string; files: string[] } | null>;
  /** The commit a worker would start from, as `filesAt` reads it (origin's copy when there is one, not fetched), with the ref's name. */
  startCommit(repoPath: string, base: string): Promise<{ ref: string; sha: string } | null>;
  /**
   * The commits on `commit`'s first-parent line made after `since` (ms since the epoch, by committer date), newest
   * first, each with the paths it changed (a merge against its first parent). At most `limit` are listed; `count` is all.
   */
  commitsSince(repoPath: string, commit: string, since: number, limit: number): Promise<{ count: number; commits: BaseCommit[] }>;
}
