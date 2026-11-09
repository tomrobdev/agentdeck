// The dashboard's server data as TanStack Query keys and options. App.vue reads them with useQuery.
import { queryOptions } from '@tanstack/vue-query';
import { api, isOffline } from './client.ts';
import type { FileRef } from './types.ts';

export const queryKeys = {
  status: ['status'] as const,
  tasks: ['tasks'] as const,
  task: (id: number) => ['task', id] as const,
  repos: ['repos'] as const,
  archivedRepos: ['repos', 'archived'] as const,
  repo: (id: number) => ['repo', id] as const,
  repoDeletion: (id: number) => ['repo', id, 'deletion'] as const,
  stats: (repo: string | null) => ['stats', repo] as const,
  settings: ['settings'] as const,
  service: ['service'] as const,
  daemon: ['daemon'] as const,
  daemonHealth: ['daemon', 'health'] as const,
  mergePreview: (id: number) => ['task', id, 'merge'] as const,
  planHtml: (id: number, planId: number, updatedAt: string) => ['task', id, 'plan', planId, updatedAt] as const,
  reviews: (id: number) => ['task', id, 'reviews'] as const,
  changes: (id: number) => ['task', id, 'changes'] as const,
  /** Under `changes`, so what refreshes the changes refreshes these too; by head, so a new commit fetches them afresh. */
  changesSince: (id: number, since: string, head: string | null) => ['task', id, 'changes', since, head] as const,
  proposalCheck: (id: number) => ['task', id, 'proposal-check'] as const,
  // Git objects at a commit never change, so these start with 'at' and the commit (null while it is unknown).
  tree: (id: number, ref: FileRef, path: string, commit: string | null) => ['at', commit, 'tree', id, ref, path] as const,
  file: (id: number, ref: FileRef, path: string, commit: string | null) => ['at', commit, 'file', id, ref, path] as const,
  diff: (id: number, path: string, head: string | null, since: string | null) => ['at', head, 'diff', id, path, since] as const,
};

/** True for a query keyed by a known commit: its data is final, so a write's refresh leaves it alone. */
export const isImmutable = (key: readonly unknown[]) => key[0] === 'at' && key[1] !== null;
const atCommit = (commit: string | null) => (commit ? Infinity : 0);

/** Offline is handled by the offline screen, which keeps polling status: don't retry it here. */
export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && failures < 2;

export const statusQuery = () => queryOptions({ queryKey: queryKeys.status, queryFn: api.status });
const STATUS_FALLBACK_MS = 30_000;
// While the daemon is down, look again often, so the screen clears soon after it starts.
const OFFLINE_POLL_MS = 3_000;
/**
 * Status as a window keeps it on screen. The change stream refetches it after writes; it also refetches every 30 s, hidden
 * or not, as waits (a governor hold lifting) change with time, not with a write.
 */
export const liveStatusQuery = () =>
  queryOptions({
    ...statusQuery(),
    refetchInterval: (q) => (isOffline(q.state.error) ? OFFLINE_POLL_MS : STATUS_FALLBACK_MS),
    refetchIntervalInBackground: true,
  });
export const tasksQuery = () => queryOptions({ queryKey: queryKeys.tasks, queryFn: api.tasks });
export const taskQuery = (id: number) => queryOptions({ queryKey: queryKeys.task(id), queryFn: () => api.task(id) });
/** The Insights page's report, per week, for one repo name or all (null). */
export const statsQuery = (repo: string | null) => queryOptions({ queryKey: queryKeys.stats(repo), queryFn: () => api.stats(repo) });
export const reposQuery = () => queryOptions({ queryKey: queryKeys.repos, queryFn: api.repos });
export const repoQuery = (id: number) => queryOptions({ queryKey: queryKeys.repo(id), queryFn: () => api.repo(id) });
export const archivedReposQuery = () => queryOptions({ queryKey: queryKeys.archivedRepos, queryFn: api.archivedRepos });
export const repoDeletionQuery = (id: number) =>
  queryOptions({ queryKey: queryKeys.repoDeletion(id), queryFn: () => api.repoDeletion(id) });
/** Copied into a form, so a reopened panel starts from the daemon's answer, not a kept one (gcTime 0). */
export const settingsQuery = () => queryOptions({ queryKey: queryKeys.settings, queryFn: api.settings, gcTime: 0 });
export const serviceQuery = () => queryOptions({ queryKey: queryKeys.service, queryFn: api.service });
export const daemonQuery = () => queryOptions({ queryKey: queryKeys.daemon, queryFn: api.daemonState });
export const daemonHealthQuery = () => queryOptions({ queryKey: queryKeys.daemonHealth, queryFn: api.daemonHealth, gcTime: 0 });
/** Read from GitHub just before a merge, so a reopened dialog never starts from an old copy (gcTime 0). */
export const mergePreviewQuery = (id: number) =>
  queryOptions({ queryKey: queryKeys.mergePreview(id), queryFn: () => api.mergePreview(id), gcTime: 0 });
export const planHtmlQuery = (id: number, planId: number, updatedAt: string) =>
  queryOptions({ queryKey: queryKeys.planHtml(id, planId, updatedAt), queryFn: () => api.planHtml(id, planId) });
export const changesQuery = (id: number) => queryOptions({ queryKey: queryKeys.changes(id), queryFn: () => api.changes(id) });
/** Read only while a proposed or queued task is shown: it reads git, so it is never part of the task's detail. */
export const proposalCheckQuery = (id: number) =>
  queryOptions({ queryKey: queryKeys.proposalCheck(id), queryFn: () => api.proposalCheck(id) });
export const treeQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({ queryKey: queryKeys.tree(id, ref, path, commit), queryFn: () => api.tree(id, ref, path), staleTime: atCommit(commit) });
export const fileQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({ queryKey: queryKeys.file(id, ref, path, commit), queryFn: () => api.file(id, ref, path), staleTime: atCommit(commit) });
/** The task's changes since a commit on its branch, at the head the changes against the base were read at. */
export const changesSinceQuery = (id: number, since: string, head: string | null) =>
  queryOptions({ queryKey: queryKeys.changesSince(id, since, head), queryFn: () => api.changes(id, since) });
/** One file's patch at the head, against the base or since a commit on the branch. */
export const diffQuery = (id: number, path: string, head: string | null, since: string | null = null) =>
  queryOptions({
    queryKey: queryKeys.diff(id, path, head, since),
    queryFn: () => api.diff(id, path, since),
    staleTime: atCommit(head),
  });
export const reviewsQuery = (id: number) => queryOptions({ queryKey: queryKeys.reviews(id), queryFn: () => api.reviews(id) });
