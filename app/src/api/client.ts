// Client for the daemon's local API (daemon/src/api/server.ts). Its types are in types.ts.
// VITE_AGENTDECK_API points a dev build at another daemon (e.g. one run on a copy of the database).
import type {
  AutoMergeRequest,
  AutoMergeResult,
  CancelResult,
  Changes,
  DaemonHealth,
  DaemonState,
  DoctorReport,
  FileContent,
  FilePatch,
  FileRef,
  MergeAllResult,
  MergePreview,
  MergeRequest,
  MergeResult,
  NewLink,
  NewRepo,
  NewReviewComment,
  NewTask,
  PlanHtml,
  ProposalResult,
  Repo,
  RepoDeleted,
  RepoDeletion,
  RepoDetail,
  RepoPatch,
  RestartNowResult,
  RestartResult,
  Review,
  ServiceStatus,
  SyncResult,
  Settings,
  SettingsPatch,
  Status,
  SubmitReview,
  TaskDetail,
  TaskSaved,
  TaskPatch,
  TaskSummary,
  TestNotifyResult,
  TreeListing,
} from './types.ts';

export const API_BASE: string = import.meta.env.VITE_AGENTDECK_API ?? 'http://127.0.0.1:4317';

export class ApiError extends Error {}

async function call<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: init?.method ?? 'GET',
      headers: init?.json ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.json ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => call<Status>('/api/status'),
  pause: () => call<Status>('/api/pause', { method: 'POST' }),
  resume: () => call<Status>('/api/resume', { method: 'POST' }),
  /** Exit once nothing is running so launchd starts the daemon on the new code. `waiting` says what it waits for. */
  restartDaemon: () => call<RestartResult>('/api/daemon/restart', { method: 'POST' }),
  /** Restart at once: the running tasks lose their run and are requeued. */
  restartDaemonNow: () => call<RestartNowResult>('/api/daemon/restart-now', { method: 'POST' }),
  daemonState: () => call<DaemonState>('/api/daemon'),
  /** `agentdeck doctor`, the checkout's HEAD, what is running and the last lines of the daemon log. */
  daemonHealth: () => call<DaemonHealth>('/api/daemon/health'),
  settings: () => call<Settings>('/api/settings'),
  updateSettings: (patch: SettingsPatch) => call<Settings>('/api/settings', { method: 'POST', json: patch }),
  testNotify: () => call<TestNotifyResult>('/api/notify/test', { method: 'POST' }),
  repos: () => call<Repo[]>('/api/repos'),
  addRepo: (r: NewRepo) => call<Repo>('/api/repos', { method: 'POST', json: r }),
  repo: (id: number) => call<RepoDetail>(`/api/repos/${id}`),
  updateRepo: (id: number, patch: RepoPatch) => call<RepoDetail>(`/api/repos/${id}`, { method: 'POST', json: patch }),
  propose: (id: number) => call<ProposalResult>(`/api/repos/${id}/plan`, { method: 'POST' }),
  doctor: (id: number) => call<DoctorReport>(`/api/repos/${id}/doctor`, { method: 'POST' }),
  resumeRepo: (id: number) => call<Repo>(`/api/repos/${id}/resume`, { method: 'POST' }),
  archivedRepos: () => call<Repo[]>('/api/repos?archived=1'),
  archiveRepo: (id: number) => call<Repo>(`/api/repos/${id}/archive`, { method: 'POST' }),
  unarchiveRepo: (id: number) => call<Repo>(`/api/repos/${id}/unarchive`, { method: 'POST' }),
  repoDeletion: (id: number) => call<RepoDeletion>(`/api/repos/${id}/deletion`),
  /** Local only: `leftover` names files that couldn't be removed. */
  deleteRepo: (id: number) => call<RepoDeleted>(`/api/repos/${id}`, { method: 'DELETE' }),
  editTask: (id: number, patch: TaskPatch) => call<TaskSaved>(`/api/tasks/${id}`, { method: 'POST', json: patch }),
  approve: (id: number) => call<TaskDetail>(`/api/tasks/${id}/approve`, { method: 'POST' }),
  reject: (id: number) => call<TaskDetail>(`/api/tasks/${id}/reject`, { method: 'POST' }),
  service: () => call<ServiceStatus>('/api/service'),
  tasks: () => call<TaskSummary[]>('/api/tasks'),
  task: (id: number) => call<TaskDetail>(`/api/tasks/${id}`),
  addTask: (t: NewTask) => call<TaskSaved>('/api/tasks', { method: 'POST', json: t }),
  /** Link the task to another; refused (a cycle, itself, already linked) with the reason as the error. */
  linkTask: (id: number, link: NewLink) => call<TaskDetail>(`/api/tasks/${id}/links`, { method: 'POST', json: link }),
  unlinkTask: (id: number, on: number) => call<TaskDetail>(`/api/tasks/${id}/links/${on}`, { method: 'DELETE' }),
  cancel: (id: number) => call<CancelResult>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  /** `note` is "request changes": kept on the timeline and put first in the next run's prompt. */
  retry: (id: number, note?: string) => call<TaskDetail>(`/api/tasks/${id}/retry`, { method: 'POST', json: note ? { note } : {} }),
  /** A person finished a blocked or failed task themselves; `note` is kept on the timeline. */
  markDone: (id: number, note?: string) => call<TaskDetail>(`/api/tasks/${id}/done`, { method: 'POST', json: note ? { note } : {} }),
  /** Install the packages a blocked task asked for (NEEDS deps) on its branch, then retry it. */
  installNeeds: (id: number) => call<TaskDetail>(`/api/tasks/${id}/install-needs`, { method: 'POST' }),
  closePr: (id: number) => call<TaskDetail>(`/api/tasks/${id}/close-pr`, { method: 'POST' }),
  mergePreview: (id: number) => call<MergePreview>(`/api/tasks/${id}/merge`),
  merge: (id: number, body: MergeRequest) => call<MergeResult>(`/api/tasks/${id}/merge`, { method: 'POST', json: body }),
  /** Merge these tasks' PRs, each with its own method, deleting the branches; the ones left open come back with why. */
  mergeAll: (ids: number[]) => call<MergeAllResult>('/api/tasks/merge', { method: 'POST', json: { ids } }),
  /** Let the daemon merge the task's PR on its own (true), not (false), or follow the repo (null). */
  autoMerge: (id: number, body: AutoMergeRequest) => call<AutoMergeResult>(`/api/tasks/${id}/auto-merge`, { method: 'POST', json: body }),
  /** Merge the base branch into the task's branch; a conflict starts a claude run, so this can take minutes. */
  sync: (id: number) => call<SyncResult>(`/api/tasks/${id}/resolve`, { method: 'POST' }),
  changes: (id: number) => call<Changes>(`/api/tasks/${id}/changes`),
  diff: (id: number, path: string) => call<FilePatch>(`/api/tasks/${id}/diff?path=${encodeURIComponent(path)}`),
  tree: (id: number, ref: FileRef, path = '') => call<TreeListing>(`/api/tasks/${id}/tree?ref=${ref}&path=${encodeURIComponent(path)}`),
  file: (id: number, ref: FileRef, path: string) => call<FileContent>(`/api/tasks/${id}/file?ref=${ref}&path=${encodeURIComponent(path)}`),
  reviews: (id: number) => call<Review[]>(`/api/tasks/${id}/reviews`),
  /** The task's draft review, started if it has none. */
  startReview: (id: number) => call<Review>(`/api/tasks/${id}/reviews`, { method: 'POST' }),
  /** Change a draft's overall note. */
  editReview: (id: number, body: string) => call<Review>(`/api/reviews/${id}`, { method: 'POST', json: { body } }),
  addComment: (reviewId: number, c: NewReviewComment) => call<Review>(`/api/reviews/${reviewId}/comments`, { method: 'POST', json: c }),
  deleteComment: (id: number) => call<Review>(`/api/review-comments/${id}`, { method: 'DELETE' }),
  /** Request changes also retries the task with the review as the reason. */
  submitReview: (id: number, body: SubmitReview) => call<Review>(`/api/reviews/${id}/submit`, { method: 'POST', json: body }),
  resolveComment: (id: number) => call<Review>(`/api/review-comments/${id}/resolve`, { method: 'POST' }),
  reopenComment: (id: number) => call<Review>(`/api/review-comments/${id}/reopen`, { method: 'POST' }),
  planHtml: (id: number, planId: number) => call<PlanHtml>(`/api/tasks/${id}/plans/${planId}`),
  logUrl: (id: number, runId?: number) => `${API_BASE}/api/tasks/${id}/log${runId ? `?run=${runId}` : ''}`,
};
