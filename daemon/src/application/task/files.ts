// Use cases for reading a task's code: what its branch changed, and its files at head or base.
// All git reads run in the repo's main checkout, which shares refs with the task worktrees.
import { branchCommit, changedFiles, commitsBetween, diffBase, filePatch, listTree, objectAt, readFile } from '../../adapters/git.ts';
import type { Db } from '../../db/index.ts';
import {
  type ChangedFile,
  type Changes,
  FILE_REFS,
  type FileContent,
  type FilePatch,
  type FileRef,
  TEXT_LIMIT,
  type Tree,
  capText,
  checkPath,
  isBinary,
} from '../../domain/files/files.ts';
import type { AutoMergeMeasured } from '../../domain/pull-request/auto-merge.ts';
import type { Repo } from '../../domain/repo/repo.ts';
import { ActionError, requireTask, requireTaskRepo } from '../input.ts';

/** The task's repo and the commit its branch is at. */
async function resolveHead(db: Db, id: number): Promise<{ repo: Repo; head: string }> {
  const task = requireTask(db, id);
  const repo = requireTaskRepo(db, task);
  const head = task.checkout?.branch ? await branchCommit(repo.path, task.checkout.branch) : null;
  if (!head) throw new ActionError('task has no branch yet');
  return { repo, head };
}

/** Where the commit `head` left the repo's base branch. */
async function baseOf(repo: Repo, head: string): Promise<{ ref: string; sha: string }> {
  const base = await diffBase(repo.path, repo.base_branch, head);
  if (!base) throw new ActionError(`no common history with base branch "${repo.base_branch}"`);
  return base;
}

/** Plus where that branch left the base branch. */
async function taskRefs(db: Db, id: number): Promise<{ repo: Repo; head: string; base: { ref: string; sha: string } }> {
  const { repo, head } = await resolveHead(db, id);
  return { repo, head, base: await baseOf(repo, head) };
}

/** The commit a file ref names; only `base` needs the merge-base lookup. */
async function resolveRef(db: Db, id: number, ref: FileRef): Promise<{ repo: Repo; sha: string }> {
  if (ref === 'head') {
    const { repo, head } = await resolveHead(db, id);
    return { repo, sha: head };
  }
  const { repo, base } = await taskRefs(db, id);
  return { repo, sha: base.sha };
}

/**
 * Changed files between two commits never change, and the diff view asks for them once per file
 * it shows (to find renames), so the last few results are kept.
 */
const changedCache = new Map<string, Promise<ChangedFile[]>>();
const CHANGED_CACHE_SIZE = 16;
function changedFilesCached(repoPath: string, base: string, head: string): Promise<ChangedFile[]> {
  const key = `${repoPath}\0${base}..${head}`;
  let hit = changedCache.get(key);
  if (hit)
    changedCache.delete(key); // re-insert below, so it counts as recently used
  else hit = changedFiles(repoPath, base, head).catch((err) => (changedCache.delete(key), Promise.reject(err)));
  changedCache.set(key, hit);
  if (changedCache.size > CHANGED_CACHE_SIZE) changedCache.delete(changedCache.keys().next().value!);
  return hit;
}

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

export async function taskChanges(db: Db, id: number): Promise<Changes> {
  const { repo, head, base } = await taskRefs(db, id);
  const [files, commits] = await Promise.all([changedFilesCached(repo.path, base.sha, head), commitsBetween(repo.path, base.sha, head)]);
  return { base_ref: base.ref, base: base.sha, head, files, commits };
}

/**
 * A task branch measured against the auto-merge limits: the lines it changed against the base (binary files count none)
 * and its paths, renames by both names. Null when git can't say (no branch yet, no common history).
 */
export async function measureBranch(repo: Repo, branch: string): Promise<AutoMergeMeasured | null> {
  try {
    const head = await branchCommit(repo.path, branch);
    if (!head) return null;
    const base = await baseOf(repo, head);
    const files = await changedFilesCached(repo.path, base.sha, head);
    return {
      lines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      paths: files.flatMap((f) => (f.old_path ? [f.path, f.old_path] : [f.path])),
    };
  } catch {
    return null;
  }
}

/** The patch of one changed file, cut at PATCH_LIMIT. */
export async function taskDiff(db: Db, id: number, rawPath: string | null): Promise<FilePatch> {
  const p = path(rawPath);
  const { repo, head, base } = await taskRefs(db, id);
  const file = (await changedFilesCached(repo.path, base.sha, head)).find((f) => f.path === p);
  if (!file) throw new ActionError(`${p} is not changed on this task's branch`);
  const { patch, truncated } = await filePatch(repo.path, base.sha, head, file.old_path ? [file.old_path, p] : [p]);
  return { path: p, patch, truncated };
}

/** One level of a folder at head or base, folders first. */
export async function taskTree(db: Db, id: number, rawRef: string | null, rawPath: string | null): Promise<Tree> {
  const ref = parseFileRef(rawRef);
  const dir = path(rawPath, { allowRoot: true });
  const { repo, sha } = await resolveRef(db, id, ref);
  if ((await objectAt(repo.path, sha, dir))?.type !== 'tree') throw new ActionError(`no folder ${dir} at ${ref}`);
  return { ref, sha, path: dir, entries: await listTree(repo.path, sha, dir) };
}

/** A file at head or base. Text is cut at TEXT_LIMIT; a binary file has no text. */
export async function taskFile(db: Db, id: number, rawRef: string | null, rawPath: string | null): Promise<FileContent> {
  const ref = parseFileRef(rawRef);
  const p = path(rawPath);
  const { repo, sha } = await resolveRef(db, id, ref);
  const file = await readFile(repo.path, sha, p, TEXT_LIMIT);
  if (!file) throw new ActionError(`no file ${p} at ${ref}`);
  const binary = isBinary(file.bytes);
  const { text, truncated } = binary ? { text: null, truncated: false } : capText(file.bytes, TEXT_LIMIT);
  return { path: p, ref, sha, size: file.size, binary, truncated: truncated || file.truncated, text };
}
