// The Workspace port: git, the shell and a worktree's files, in the operations the use cases need.
import type { AddedLines } from '#domain/landing/index.ts';
import type { ReviewFacts } from '#domain/operations/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { BaseCommit, ChangedFile, Commit, Task, TreeEntry } from '#domain/work/index.ts';

export interface Checkout {
  branch: string;
  path: string;
}

export interface RepoFacts {
  branch: string;
  origin: boolean;
  base: string | null;
}

export interface Head {
  branch: string;
  sha: string;
  short: string;
  subject: string;
}

export interface RootInfo {
  files: string[];
  scripts: string[];
}

export interface CommandResult {
  passed: boolean;
  output: string;
}

export type SyncStart =
  | { kind: 'no_base'; ref: string }
  | { kind: 'up_to_date' }
  | { kind: 'merged'; before: string }
  | { kind: 'conflicts'; before: string; files: string[]; ours: string[]; theirs: string[] };

export type SyncFinish = { kind: 'done' } | { kind: 'markers'; files: string[] } | { kind: 'unfinished' } | { kind: 'not_committed' };

export interface AppliedEdits {
  applied: string[];
  refused: { path: string; reason: string }[];
}

export interface Workspace {
  prepareCheckout(repo: Repo, task: Task, target: string): Promise<Checkout>;
  removeCheckout(repo: Repo, checkout: { worktree?: string | null; branch?: string | null }): Promise<void>;
  withScratchCheckout<T>(repo: Repo, branch: string, use: (checkout: { path: string } | { error: string }) => Promise<T>): Promise<T>;

  inspectRepo(path: string, base?: string): Promise<RepoFacts | null>;
  rootInfo(dir: string): Promise<RootInfo>;
  head(cwd: string): Promise<Head | null>;
  commitsAhead(cwd: string, base: string): Promise<number>;
  unpushedCommits(worktree: string, branch: string): Promise<number | null>;
  reviewFacts(repoPath: string, base: string, since: number): Promise<ReviewFacts | null>;

  runCommand(command: string | string[], cwd: string, timeoutMs: number): Promise<CommandResult>;
  commit(worktree: string, message: string, only?: string[]): Promise<boolean>;
  applyProtectedEdits(worktree: string): Promise<AppliedEdits>;

  startSync(repo: Repo, target: string, worktree: string, leftovers: string): Promise<SyncStart>;
  finishSync(worktree: string, files: string[], before: string, leftovers: string): Promise<SyncFinish>;
  undoSync(worktree: string, before: string): Promise<void>;

  writePlanFile(worktree: string, html: string | null): Promise<void>;
  readPlanFiles(worktree: string): Promise<{ written: string | null; given: string | null }>;
  writeGivenPlan(worktree: string, html: string | null): Promise<void>;

  branchHead(repoPath: string, branch: string): Promise<string | null>;
  diffBase(repoPath: string, base: string, head: string): Promise<{ ref: string; sha: string } | null>;
  diffHash(repoPath: string, base: string, head: string): Promise<string | null>;
  compare(repoPath: string, base: string, head: string): Promise<{ files: ChangedFile[]; commits: Commit[] }>;
  filePatch(repoPath: string, base: string, head: string, paths: string[]): Promise<{ patch: string; truncated: boolean }>;
  addedLines(repoPath: string, base: string, head: string): Promise<AddedLines | null>;
  mergeCommit(repoPath: string, ours: string, theirs: string): Promise<string | null>;
  listTree(repoPath: string, commit: string, dir: string): Promise<TreeEntry[] | null>;
  readFile(
    repoPath: string,
    commit: string,
    path: string,
    limit: number,
  ): Promise<{ size: number; bytes: Buffer; truncated: boolean } | null>;
  filesAt(repoPath: string, at: { base: string } | { branch: string }): Promise<{ ref: string; files: string[] } | null>;
  startCommit(repoPath: string, base: string): Promise<{ ref: string; sha: string } | null>;
  commitsSince(repoPath: string, commit: string, since: number, limit: number): Promise<{ count: number; commits: BaseCommit[] }>;
}
