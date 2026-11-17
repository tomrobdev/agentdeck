// What a person should know before approving a proposed or queued task: how far the base moved since it was added, which paths it names are gone (promptWarnings), and which open tasks touch the same files.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { sqliteMs } from '#domain/shared/index.ts';
import {
  CHECKED_STATUSES,
  type Overlap,
  type ProposalCheck,
  type Staleness,
  type Task,
  emptyProposalCheck,
  mayOverlap,
  overlaps,
  pathsNamedIn,
  staleness,
} from '#domain/work/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { measureBranch } from '#application/work/files.ts';
import { promptWarnings } from '#application/work/prompt-paths.ts';
import { promiseCache } from '#application/shared/cache.ts';
import { requireTask, requireTaskRepo } from '#application/shared/input.ts';

const COMMIT_LIMIT = 500;

const stalenessCache = promiseCache<Staleness>(32);

async function stalenessOf(app: App, repo: Repo, task: Task): Promise<Staleness | null> {
  const since = sqliteMs(task.created_at);
  if (!Number.isFinite(since)) return null;
  const start = await app.workspace.startCommit(repo.path, repo.base_branch);
  if (!start) return null;
  return stalenessCache(`${task.id}\0${start.sha}\0${task.prompt}`, () =>
    app.workspace.commitsSince(repo.path, start.sha, since, COMMIT_LIMIT).then(({ count, commits }) => ({
      ref: start.ref,
      base: start.sha,
      ...staleness(pathsNamedIn(task.prompt), commits),
      commits: count,
    })),
  );
}

async function pathsOf(app: App, repo: Repo, task: Task): Promise<string[]> {
  const named = pathsNamedIn(task.prompt);
  const branch = task.checkout?.branch;
  const changed = branch ? ((await measureBranch(app, repo, branch))?.paths ?? []) : [];
  return [...new Set([...named, ...changed])];
}

async function overlapsOf(app: App, repo: Repo, task: Task): Promise<Overlap[]> {
  const others = app.listTasks().filter((t) => t.repo_id === task.repo_id && t.id !== task.id && mayOverlap(t));
  if (!others.length) return [];
  const own = await pathsOf(app, repo, task);
  if (!own.length) return [];
  const linked = new Set<TaskId>([...app.linksOf(task.id).map((l) => l.on), ...app.dependentsOf(task.id).map((d) => d.id)]);
  const candidates = await Promise.all(
    others.map(async (t) => ({ id: t.id, title: t.title, status: t.status, paths: await pathsOf(app, repo, t), linked: linked.has(t.id) })),
  );
  return overlaps(own, candidates);
}

export async function proposalCheck(app: App, id: TaskId): Promise<ProposalCheck> {
  const task = requireTask(app, id);
  if (!CHECKED_STATUSES.includes(task.status)) return emptyProposalCheck();
  const repo = requireTaskRepo(app, task);
  const [stale, notes, overlapping] = await Promise.all([
    stalenessOf(app, repo, task).catch(() => null),
    promptWarnings(app, id),
    overlapsOf(app, repo, task).catch(() => []),
  ]);
  return { staleness: stale, notes, overlaps: overlapping };
}
