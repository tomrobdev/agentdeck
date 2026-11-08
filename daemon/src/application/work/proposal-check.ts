// What a person should know before approving a proposed or queued task: how far the base moved since it was added,
// which paths it names are gone (promptWarnings), and which open tasks touch the same files. Its own route, never part
// of a task's detail: it reads git, and the detail is refetched on every database change.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { sqliteMs } from '../../domain/shared/index.ts';
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
} from '../../domain/work/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { measureBranch } from './files.ts';
import { promptWarnings } from './prompt-paths.ts';
import { requireTask, requireTaskRepo } from '../shared/input.ts';

/** The most commits listed with their paths; the count is of all of them. */
const COMMIT_LIMIT = 500;

/**
 * A task's staleness against a base commit never changes for the same prompt (created_at doesn't), and the dashboard
 * asks again on every database change while the task is shown, so the last few are kept, keyed by task, base commit
 * and prompt: an immutable result, as compareCached keeps compares.
 */
const stalenessCache = new Map<string, Promise<Staleness>>();
const STALENESS_CACHE_SIZE = 32;

async function stalenessOf(app: App, repo: Repo, task: Task): Promise<Staleness | null> {
  const since = sqliteMs(task.created_at); // SQLite's UTC with no zone: read as UTC, never as local time
  if (!Number.isFinite(since)) return null;
  const start = await app.workspace.startCommit(repo.path, repo.base_branch);
  if (!start) return null;
  const key = `${task.id}\0${start.sha}\0${task.prompt}`;
  let hit = stalenessCache.get(key);
  if (hit)
    stalenessCache.delete(key); // re-insert below, so it counts as recently used
  else
    hit = app.workspace.commitsSince(repo.path, start.sha, since, COMMIT_LIMIT).then(
      ({ count, commits }) => ({ ref: start.ref, base: start.sha, ...staleness(pathsNamedIn(task.prompt), commits), commits: count }),
      (err) => (stalenessCache.delete(key), Promise.reject(err)),
    );
  stalenessCache.set(key, hit);
  if (stalenessCache.size > STALENESS_CACHE_SIZE) stalenessCache.delete(stalenessCache.keys().next().value!);
  return hit;
}

/** The paths a task names, plus those its branch changed (through the cached compare) when it has one. */
async function pathsOf(app: App, repo: Repo, task: Task): Promise<string[]> {
  const named = pathsNamedIn(task.prompt);
  const branch = task.checkout?.branch;
  const changed = branch ? ((await measureBranch(app, repo, branch))?.paths ?? []) : [];
  return [...new Set([...named, ...changed])];
}

/** The other open tasks in the repo whose named or changed paths meet the task's, each marked when a link joins them. */
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

/**
 * The proposal check of a proposed or queued task: its staleness, promptWarnings' notes and its overlaps. Any other
 * status has an empty check. Git trouble leaves that part empty, never an error.
 */
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
