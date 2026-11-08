// Use cases for reading a task's code: what its branch changed, and its files at head or base.
// All git reads run in the repo's main checkout, which shares refs with the task worktrees.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import {
  type ChangedFile,
  type Changes,
  type Commit,
  FILE_REFS,
  type FileContent,
  type FilePatch,
  type FileRef,
  TEXT_LIMIT,
  type Tree,
  capText,
  checkPath,
  isBinary,
} from '../../domain/work/index.ts';
import type { AutoMergeMeasured } from '../../domain/landing/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { ActionError, requireTask, requireTaskRepo } from '../shared/input.ts';

/** The task's repo and the commit its branch is at. */
async function resolveHead(app: App, id: TaskId): Promise<{ repo: Repo; head: string }> {
  const task = requireTask(app, id);
  const repo = requireTaskRepo(app, task);
  const head = task.checkout?.branch ? await app.workspace.branchHead(repo.path, task.checkout.branch) : null;
  if (!head) throw new ActionError('task has no branch yet');
  return { repo, head };
}

/** Where the commit `head` left the repo's base branch. */
async function baseOf(app: App, repo: Repo, head: string): Promise<{ ref: string; sha: string }> {
  const base = await app.workspace.diffBase(repo.path, repo.base_branch, head);
  if (!base) throw new ActionError(`no common history with base branch "${repo.base_branch}"`);
  return base;
}

/** Plus where that branch left the base branch. */
async function taskRefs(app: App, id: TaskId): Promise<{ repo: Repo; head: string; base: { ref: string; sha: string } }> {
  const { repo, head } = await resolveHead(app, id);
  return { repo, head, base: await baseOf(app, repo, head) };
}

/** The commit a file ref names; only `base` needs the merge-base lookup. */
async function resolveRef(app: App, id: TaskId, ref: FileRef): Promise<{ repo: Repo; sha: string }> {
  if (ref === 'head') {
    const { repo, head } = await resolveHead(app, id);
    return { repo, sha: head };
  }
  const { repo, base } = await taskRefs(app, id);
  return { repo, sha: base.sha };
}

/**
 * What changed between two commits never changes, and the diff view asks for it once per file
 * it shows (to find renames), so the last few results are kept.
 */
const changedCache = new Map<string, Promise<{ files: ChangedFile[]; commits: Commit[] }>>();
const CHANGED_CACHE_SIZE = 16;
function compareCached(app: App, repoPath: string, base: string, head: string): Promise<{ files: ChangedFile[]; commits: Commit[] }> {
  const key = `${repoPath}\0${base}..${head}`;
  let hit = changedCache.get(key);
  if (hit)
    changedCache.delete(key); // re-insert below, so it counts as recently used
  else hit = app.workspace.compare(repoPath, base, head).catch((err) => (changedCache.delete(key), Promise.reject(err)));
  changedCache.set(key, hit);
  if (changedCache.size > CHANGED_CACHE_SIZE) changedCache.delete(changedCache.keys().next().value!);
  return hit;
}

const changedFilesCached = async (app: App, repoPath: string, base: string, head: string): Promise<ChangedFile[]> =>
  (await compareCached(app, repoPath, base, head)).files;

function path(input: string | null | undefined, opts: { allowRoot?: boolean } = {}): string {
  const p = checkPath(input, opts);
  if (!p.ok) throw new ActionError(p.error);
  return p.path;
}

/** `head` when omitted; anything other than head or base is refused. */
export function parseFileRef(input: string | null | undefined): FileRef {
  if (input === null || input === undefined || input === '') return 'head';
  if (!(FILE_REFS as string[]).includes(input)) throw new ActionError('ref must be head or base');
  return input as FileRef;
}

export async function taskChanges(app: App, id: TaskId): Promise<Changes> {
  const { repo, head, base } = await taskRefs(app, id);
  const { files, commits } = await compareCached(app, repo.path, base.sha, head);
  return { base_ref: base.ref, base: base.sha, head, files, commits };
}

/**
 * A task branch measured against the auto-merge limits: the lines it changed against the base (binary files count none)
 * and its paths, renames by both names, from `git diff --numstat` in the repo's checkout. Null when git can't say (no branch
 * yet, no common history), or when `at` is given and the branch is at another commit (the PR's head is not the local branch's).
 */
export async function measureBranch(app: App, repo: Repo, branch: string, at?: string | null): Promise<AutoMergeMeasured | null> {
  try {
    const head = await app.workspace.branchHead(repo.path, branch);
    if (!head || (at && head !== at)) return null;
    const base = await baseOf(app, repo, head);
    const files = await changedFilesCached(app, repo.path, base.sha, head);
    return {
      lines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      paths: files.flatMap((f) => (f.old_path ? [f.path, f.old_path] : [f.path])),
    };
  } catch {
    return null;
  }
}

/** The patch of one changed file, cut at PATCH_LIMIT. */
export async function taskDiff(app: App, id: TaskId, rawPath: string | null): Promise<FilePatch> {
  const p = path(rawPath);
  const { repo, head, base } = await taskRefs(app, id);
  const file = (await changedFilesCached(app, repo.path, base.sha, head)).find((f) => f.path === p);
  if (!file) throw new ActionError(`${p} is not changed on this task's branch`);
  const { patch, truncated } = await app.workspace.filePatch(repo.path, base.sha, head, file.old_path ? [file.old_path, p] : [p]);
  return { path: p, patch, truncated };
}

/** One level of a folder at head or base, folders first. */
export async function taskTree(app: App, id: TaskId, rawRef: string | null, rawPath: string | null): Promise<Tree> {
  const ref = parseFileRef(rawRef);
  const dir = path(rawPath, { allowRoot: true });
  const { repo, sha } = await resolveRef(app, id, ref);
  const entries = await app.workspace.listTree(repo.path, sha, dir);
  if (!entries) throw new ActionError(`no folder ${dir} at ${ref}`);
  return { ref, sha, path: dir, entries };
}

/** A file at head or base. Text is cut at TEXT_LIMIT; a binary file has no text. */
export async function taskFile(app: App, id: TaskId, rawRef: string | null, rawPath: string | null): Promise<FileContent> {
  const ref = parseFileRef(rawRef);
  const p = path(rawPath);
  const { repo, sha } = await resolveRef(app, id, ref);
  const file = await app.workspace.readFile(repo.path, sha, p, TEXT_LIMIT);
  if (!file) throw new ActionError(`no file ${p} at ${ref}`);
  const binary = isBinary(file.bytes);
  const { text, truncated } = binary ? { text: null, truncated: false } : capText(file.bytes, TEXT_LIMIT);
  return { path: p, ref, sha, size: file.size, binary, truncated: truncated || file.truncated, text };
}
