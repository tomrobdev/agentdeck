// The dashboard's server data as TanStack Query keys and options. App.vue reads them with useQuery.
import { queryOptions } from '@tanstack/vue-query';
import { ApiError, api } from './client.ts';
import type { FileRef } from './types.ts';

export const queryKeys = {
  status: ['status'] as const,
  tasks: ['tasks'] as const,
  task: (id: number) => ['task', id] as const,
  repos: ['repos'] as const,
  archivedRepos: ['repos', 'archived'] as const,
  repo: (id: number) => ['repo', id] as const,
  repoDeletion: (id: number) => ['repo', id, 'deletion'] as const,
  settings: ['settings'] as const,
  service: ['service'] as const,
  mergePreview: (id: number) => ['task', id, 'merge'] as const,
  planHtml: (id: number, planId: number, updatedAt: string) => ['task', id, 'plan', planId, updatedAt] as const,
  changes: (id: number) => ['task', id, 'changes'] as const,
  // Git objects at a commit never change, so these start with 'at' and the commit (null while it is unknown).
  tree: (id: number, ref: FileRef, path: string, commit: string | null) => ['at', commit, 'tree', id, ref, path] as const,
  file: (id: number, ref: FileRef, path: string, commit: string | null) => ['at', commit, 'file', id, ref, path] as const,
  diff: (id: number, path: string, head: string | null) => ['at', head, 'diff', id, path] as const,
};

/** True for a query keyed by a known commit: its data is final, so a write's refresh leaves it alone. */
export const isImmutable = (key: readonly unknown[]) => key[0] === 'at' && key[1] !== null;
const atCommit = (commit: string | null) => (commit ? Infinity : 0);

/** True for the error `call` throws when the daemon can't be reached. */
export const isOffline = (e: unknown) => e instanceof ApiError && e.message === 'offline';

/** Offline is handled by the offline screen, which keeps polling status: don't retry it here. */
export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && failures < 2;

export const statusQuery = () => queryOptions({ queryKey: queryKeys.status, queryFn: api.status });
export const tasksQuery = () => queryOptions({ queryKey: queryKeys.tasks, queryFn: api.tasks });
export const taskQuery = (id: number) => queryOptions({ queryKey: queryKeys.task(id), queryFn: () => api.task(id) });
export const reposQuery = () => queryOptions({ queryKey: queryKeys.repos, queryFn: api.repos });
export const repoQuery = (id: number) => queryOptions({ queryKey: queryKeys.repo(id), queryFn: () => api.repo(id) });
export const archivedReposQuery = () => queryOptions({ queryKey: queryKeys.archivedRepos, queryFn: api.archivedRepos });
export const repoDeletionQuery = (id: number) =>
  queryOptions({ queryKey: queryKeys.repoDeletion(id), queryFn: () => api.repoDeletion(id) });
/** Copied into a form, so a reopened panel starts from the daemon's answer, not a kept one (gcTime 0). */
export const settingsQuery = () => queryOptions({ queryKey: queryKeys.settings, queryFn: api.settings, gcTime: 0 });
export const serviceQuery = () => queryOptions({ queryKey: queryKeys.service, queryFn: api.service });
/** Read from GitHub just before a merge, so a reopened dialog never starts from an old copy (gcTime 0). */
export const mergePreviewQuery = (id: number) =>
  queryOptions({ queryKey: queryKeys.mergePreview(id), queryFn: () => api.mergePreview(id), gcTime: 0 });
export const planHtmlQuery = (id: number, planId: number, updatedAt: string) =>
  queryOptions({ queryKey: queryKeys.planHtml(id, planId, updatedAt), queryFn: () => api.planHtml(id, planId) });
export const changesQuery = (id: number) => queryOptions({ queryKey: queryKeys.changes(id), queryFn: () => api.changes(id) });
export const treeQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({ queryKey: queryKeys.tree(id, ref, path, commit), queryFn: () => api.tree(id, ref, path), staleTime: atCommit(commit) });
export const fileQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({ queryKey: queryKeys.file(id, ref, path, commit), queryFn: () => api.file(id, ref, path), staleTime: atCommit(commit) });
export const diffQuery = (id: number, path: string, head: string | null) =>
  queryOptions({ queryKey: queryKeys.diff(id, path, head), queryFn: () => api.diff(id, path), staleTime: atCommit(head) });
