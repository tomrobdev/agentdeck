// Use cases for reading a task's code: what its branch changed, and its files at head or base.
// All git reads run in the repo's main checkout, which shares refs with the task worktrees.
import { changedFiles, commitsBetween, diffBase, filePatch, listTree, objectAt, readFile, resolveCommit } from '../adapters/git.ts';
import type { Db } from '../db/index.ts';
import {
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
} from '../domain/files/files.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { ActionError } from './errors.ts';

interface TaskCommits {
  repo: Repo;
  head: string;
  base: { ref: string; sha: string };
}

/** The task's repo, the commit its branch is at, and where that branch left the base branch. */
async function resolveTask(db: Db, id: number): Promise<TaskCommits> {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  const repo = db.getRepo(task.repo_id);
  if (!repo) throw new ActionError('the task has no repo');
  const head = task.branch ? await resolveCommit(repo.path, `refs/heads/${task.branch}`) : null;
  if (!head) throw new ActionError('task has no branch yet');
  const base = await diffBase(repo.path, repo.base_branch, head);
  if (!base) throw new ActionError(`no common history with base branch "${repo.base_branch}"`);
  return { repo, head, base };
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
  const { repo, head, base } = await resolveTask(db, id);
  const [files, commits] = await Promise.all([changedFiles(repo.path, base.sha, head), commitsBetween(repo.path, base.sha, head)]);
  return { base_ref: base.ref, base: base.sha, head, files, commits };
}

/** The patch of one changed file, cut at PATCH_LIMIT. */
export async function taskDiff(db: Db, id: number, rawPath: string | null): Promise<FilePatch> {
  const p = path(rawPath);
  const { repo, head, base } = await resolveTask(db, id);
  const file = (await changedFiles(repo.path, base.sha, head)).find((f) => f.path === p);
  if (!file) throw new ActionError(`${p} is not changed on this task's branch`);
  const { patch, truncated } = await filePatch(repo.path, base.sha, head, file.old_path ? [file.old_path, p] : [p]);
  return { path: p, patch, truncated };
}

/** One level of a folder at head or base, folders first. */
export async function taskTree(db: Db, id: number, rawRef: string | null, rawPath: string | null): Promise<Tree> {
  const ref = parseFileRef(rawRef);
  const dir = path(rawPath, { allowRoot: true });
  const t = await resolveTask(db, id);
  const sha = ref === 'head' ? t.head : t.base.sha;
  if ((await objectAt(t.repo.path, sha, dir))?.type !== 'tree') throw new ActionError(`no folder ${dir} at ${ref}`);
  return { ref, sha, path: dir, entries: await listTree(t.repo.path, sha, dir) };
}

/** A file at head or base. Text is cut at TEXT_LIMIT; a binary file has no text. */
export async function taskFile(db: Db, id: number, rawRef: string | null, rawPath: string | null): Promise<FileContent> {
  const ref = parseFileRef(rawRef);
  const p = path(rawPath);
  const t = await resolveTask(db, id);
  const sha = ref === 'head' ? t.head : t.base.sha;
  const file = await readFile(t.repo.path, sha, p, TEXT_LIMIT);
  if (!file) throw new ActionError(`no file ${p} at ${ref}`);
  const binary = isBinary(file.bytes);
  const { text, truncated } = binary ? { text: null, truncated: false } : capText(file.bytes, TEXT_LIMIT);
  return { path: p, ref, sha, size: file.size, binary, truncated: truncated || file.truncated, text };
}
