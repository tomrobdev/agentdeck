// The dashboard's server data as TanStack Query options, each with its key: components read them with useQuery, and a
// write that needs a key takes it from the option (`repoQuery(id).queryKey`).
import { type QueryClient, queryOptions } from '@tanstack/vue-query';
import { api, isOffline } from './client.ts';
import type { FileRef } from './types.ts';

// Git objects at a commit never change, so their keys start with 'at' and the commit (null while it is unknown).
const isImmutable = (key: readonly unknown[]) => key[0] === 'at' && key[1] !== null;
const atCommit = (commit: string | null) => (commit ? Infinity : 0);

/** Refetches everything after a write, except what is keyed by a known commit: its data is final. */
export const refreshAll = (queryClient: QueryClient) => queryClient.invalidateQueries({ predicate: (q) => !isImmutable(q.queryKey) });

/** Offline is handled by the offline screen, which keeps polling status: don't retry it here. */
export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && failures < 2;

const STATUS_FALLBACK_MS = 30_000;
// While the daemon is down, look again often, so the screen clears soon after it starts.
const OFFLINE_POLL_MS = 3_000;
/**
 * Status as a window keeps it on screen. The change stream refetches it after writes; it also refetches every 30 s, hidden
 * or not, as waits (a governor hold lifting) change with time, not with a write.
 */
export const liveStatusQuery = () =>
  queryOptions({
    queryKey: ['status'] as const,
    queryFn: api.status,
    refetchInterval: (q) => (isOffline(q.state.error) ? OFFLINE_POLL_MS : STATUS_FALLBACK_MS),
    refetchIntervalInBackground: true,
  });

// ---- The daemon and its settings
/** Copied into a form, so a reopened panel starts from the daemon's answer, not a kept one (gcTime 0). */
export const settingsQuery = () => queryOptions({ queryKey: ['settings'] as const, queryFn: api.settings, gcTime: 0 });
export const serviceQuery = () => queryOptions({ queryKey: ['service'] as const, queryFn: api.service });
export const daemonQuery = () => queryOptions({ queryKey: ['daemon'] as const, queryFn: api.daemonState });
export const daemonHealthQuery = () => queryOptions({ queryKey: ['daemon', 'health'] as const, queryFn: api.daemonHealth, gcTime: 0 });
/** The Insights page's report, per week, for one repo name or all (null). */
export const statsQuery = (repo: string | null) => queryOptions({ queryKey: ['stats', repo] as const, queryFn: () => api.stats(repo) });

// ---- Repos
export const reposQuery = () => queryOptions({ queryKey: ['repos'] as const, queryFn: api.repos });
export const archivedReposQuery = () => queryOptions({ queryKey: ['repos', 'archived'] as const, queryFn: api.archivedRepos });
export const repoQuery = (id: number) => queryOptions({ queryKey: ['repo', id] as const, queryFn: () => api.repo(id) });
export const repoDeletionQuery = (id: number) =>
  queryOptions({ queryKey: ['repo', id, 'deletion'] as const, queryFn: () => api.repoDeletion(id) });

// ---- Tasks
export const tasksQuery = () => queryOptions({ queryKey: ['tasks'] as const, queryFn: api.tasks });
export const taskQuery = (id: number) => queryOptions({ queryKey: ['task', id] as const, queryFn: () => api.task(id) });
/** Read only while a proposed or queued task is shown: it reads git, so it is never part of the task's detail. */
export const proposalCheckQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'proposal-check'] as const, queryFn: () => api.proposalCheck(id) });
/** Keyed by the plan's `updated_at`, so an edited plan is fetched afresh. */
export const planHtmlQuery = (id: number, planId: number, updatedAt: string) =>
  queryOptions({ queryKey: ['task', id, 'plan', planId, updatedAt] as const, queryFn: () => api.planHtml(id, planId) });
/** Read from GitHub just before a merge, so a reopened dialog never starts from an old copy (gcTime 0). */
export const mergePreviewQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'merge'] as const, queryFn: () => api.mergePreview(id), gcTime: 0 });
export const reviewsQuery = (id: number) => queryOptions({ queryKey: ['task', id, 'reviews'] as const, queryFn: () => api.reviews(id) });

// ---- Changes and files
export const changesQuery = (id: number) => queryOptions({ queryKey: ['task', id, 'changes'] as const, queryFn: () => api.changes(id) });
/** The task's changes since a commit on its branch, keyed by the head the changes against the base were read at. */
export const changesSinceQuery = (id: number, since: string, head: string | null) =>
  queryOptions({ queryKey: ['task', id, 'changes', since, head] as const, queryFn: () => api.changes(id, since) });
export const treeQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({
    queryKey: ['at', commit, 'tree', id, ref, path] as const,
    queryFn: () => api.tree(id, ref, path),
    staleTime: atCommit(commit),
  });
export const fileQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({
    queryKey: ['at', commit, 'file', id, ref, path] as const,
    queryFn: () => api.file(id, ref, path),
    staleTime: atCommit(commit),
  });
/** One file's patch at the head, against the base or since a commit on the branch. */
export const diffQuery = (id: number, path: string, head: string | null, since: string | null = null) =>
  queryOptions({
    queryKey: ['at', head, 'diff', id, path, since] as const,
    queryFn: () => api.diff(id, path, since),
    staleTime: atCommit(head),
  });
