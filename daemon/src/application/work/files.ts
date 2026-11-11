// Use cases for reading a task's code: what its branch changed, and its files at head or base.
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
  sincePoints,
} from '../../domain/work/index.ts';
import { type AutoMergeMeasured, countCodeComments } from '../../domain/landing/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { promiseCache } from '../shared/cache.ts';
import { ActionError, requireTask, requireTaskRepo } from '../shared/input.ts';

async function resolveHead(app: App, id: TaskId): Promise<{ repo: Repo; head: string }> {
  const task = requireTask(app, id);
  const repo = requireTaskRepo(app, task);
  const head = task.checkout?.branch ? await app.workspace.branchHead(repo.path, task.checkout.branch) : null;
  if (!head) throw new ActionError('task has no branch yet');
  return { repo, head };
}

async function baseOf(app: App, repo: Repo, head: string): Promise<{ ref: string; sha: string }> {
  const base = await app.workspace.diffBase(repo.path, repo.base_branch, head);
  if (!base) throw new ActionError(`no common history with base branch "${repo.base_branch}"`);
  return base;
}

async function taskRefs(app: App, id: TaskId): Promise<{ repo: Repo; head: string; base: { ref: string; sha: string } }> {
  const { repo, head } = await resolveHead(app, id);
  return { repo, head, base: await baseOf(app, repo, head) };
}

async function resolveRef(app: App, id: TaskId, ref: FileRef): Promise<{ repo: Repo; sha: string }> {
  if (ref === 'head') {
    const { repo, head } = await resolveHead(app, id);
    return { repo, sha: head };
  }
  const { repo, base } = await taskRefs(app, id);
  return { repo, sha: base.sha };
}

const changedCache = promiseCache<{ files: ChangedFile[]; commits: Commit[] }>(16);
const compareCached = (app: App, repoPath: string, base: string, head: string): Promise<{ files: ChangedFile[]; commits: Commit[] }> =>
  changedCache(`${repoPath}\0${base}..${head}`, () => app.workspace.compare(repoPath, base, head));

const changedFilesCached = async (app: App, repoPath: string, base: string, head: string): Promise<ChangedFile[]> =>
  (await compareCached(app, repoPath, base, head)).files;

function path(input: string | null | undefined, opts: { allowRoot?: boolean } = {}): string {
  const p = checkPath(input, opts);
  if (!p.ok) throw new ActionError(p.error);
  return p.path;
}

export function parseFileRef(input: string | null | undefined): FileRef {
  if (input === null || input === undefined || input === '') return 'head';
  if (!(FILE_REFS as string[]).includes(input)) throw new ActionError('ref must be head or base');
  return input as FileRef;
}

export function parseSince(input: string | null | undefined): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input)) throw new ActionError('since must be a whole commit id');
  return input;
}

const mergeCache = promiseCache<string | null>(16);
const mergeCached = (app: App, repoPath: string, ours: string, theirs: string): Promise<string | null> =>
  mergeCache(`${repoPath}\0${ours}\0${theirs}`, () => app.workspace.mergeCommit(repoPath, ours, theirs));

async function sinceFrom(
  app: App,
  repo: Repo,
  base: string,
  head: string,
  since: string,
): Promise<{ from: string; base_may_show: boolean; branch: { files: ChangedFile[]; commits: Commit[] } }> {
  const branch = await compareCached(app, repo.path, base, head);
  if (!branch.commits.some((c) => c.sha === since)) throw new ActionError(`${since.slice(0, 7)} is not a commit on this task's branch`);
  const merged = await mergeCached(app, repo.path, since, base);
  return merged ? { from: merged, base_may_show: false, branch } : { from: since, base_may_show: true, branch };
}

export async function taskChanges(app: App, id: TaskId, rawSince?: string | null): Promise<Changes> {
  const since = parseSince(rawSince);
  const { repo, head, base } = await taskRefs(app, id);
  const branch = await compareCached(app, repo.path, base.sha, head);
  const since_points = sincePoints(branch.commits, app.runsForTask(id), app.reviewsForTask(id), head);
  const changes = { base_ref: base.ref, base: base.sha, head, since_points };
  if (!since) return { ...changes, since: null, base_may_show: false, ...branch };
  const { from, base_may_show } = await sinceFrom(app, repo, base.sha, head, since);
  const { files, commits } = await compareCached(app, repo.path, from, head);
  return { ...changes, since, base_may_show, files, commits };
}

export async function measureBranch(app: App, repo: Repo, branch: string, at?: string | null): Promise<AutoMergeMeasured | null> {
  try {
    const head = await app.workspace.branchHead(repo.path, branch);
    if (!head || (at && head !== at)) return null;
    const base = await baseOf(app, repo, head);
    const [files, added] = await Promise.all([
      changedFilesCached(app, repo.path, base.sha, head),
      app.workspace.addedLines(repo.path, repo.base_branch, head),
    ]);
    return {
      lines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      paths: files.flatMap((f) => (f.old_path ? [f.path, f.old_path] : [f.path])),
      code_comments: added ? countCodeComments(added) : null,
    };
  } catch {
    return null;
  }
}

export async function taskDiff(app: App, id: TaskId, rawPath: string | null, rawSince?: string | null): Promise<FilePatch> {
  const p = path(rawPath);
  const since = parseSince(rawSince);
  const { repo, head, base } = await taskRefs(app, id);
  const from = since ? (await sinceFrom(app, repo, base.sha, head, since)).from : base.sha;
  const file = (await changedFilesCached(app, repo.path, from, head)).find((f) => f.path === p);
  if (!file) throw new ActionError(`${p} is not changed on this task's branch${since ? ` since ${since.slice(0, 7)}` : ''}`);
  const { patch, truncated } = await app.workspace.filePatch(repo.path, from, head, file.old_path ? [file.old_path, p] : [p]);
  return { path: p, patch, truncated };
}

export async function taskTree(app: App, id: TaskId, rawRef: string | null, rawPath: string | null): Promise<Tree> {
  const ref = parseFileRef(rawRef);
  const dir = path(rawPath, { allowRoot: true });
  const { repo, sha } = await resolveRef(app, id, ref);
  const entries = await app.workspace.listTree(repo.path, sha, dir);
  if (!entries) throw new ActionError(`no folder ${dir} at ${ref}`);
  return { ref, sha, path: dir, entries };
}

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
