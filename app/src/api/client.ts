// Client for the daemon's local API (daemon/src/api/server.ts). Its types are in types.ts.
// VITE_AGENTDECK_API points a dev build at another daemon (e.g. one run on a copy of the database).
import type {
  AutoMergeRequest,
  AutoMergeResult,
  CancelMergeRequestResult,
  CancelResult,
  Changes,
  DaemonHealth,
  DaemonState,
  DoctorReport,
  FileContent,
  FilePatch,
  FileRef,
  FixChecksResult,
  MarkDoneRequest,
  MergePreview,
  MergeRequest,
  MergeResult,
  NewLink,
  NewRepo,
  NewReviewComment,
  NewTask,
  OpenPrResult,
  PlanHtml,
  ProposalCheck,
  ProposalResult,
  Repo,
  RepoDeleted,
  RepoDeletion,
  RepoDetail,
  RepoPatch,
  RequestMergeRequest,
  RequestMergeResult,
  RequestMergesRequest,
  RequestMergesResult,
  RestartNowResult,
  RestartResult,
  RetryRequest,
  Review,
  ReviewPatch,
  ServiceStatus,
  Settings,
  SettingsPatch,
  Stats,
  Status,
  SubmitReview,
  SyncResult,
  TaskDetail,
  TaskPatch,
  TaskSaved,
  TaskSummary,
  TestNotifyResult,
  TreeListing,
  VerifyResult,
} from './types.ts';
import { asTaskId } from '../../../daemon/src/domain/shared/index.ts';
import type { PersonEvent } from '../../../daemon/src/domain/work/index.ts';

// The dashboard keeps ids as numbers (from the URL, from typing); a request body brands them here, where they enter the API.
type NewTaskInput = Omit<NewTask, 'builds_on' | 'after' | 'plan_task'> & { builds_on?: number[]; after?: number[]; plan_task?: number };
const brandNewTask = ({ builds_on, after, plan_task, ...rest }: NewTaskInput): NewTask => ({
  ...rest,
  ...(builds_on && { builds_on: builds_on.map(asTaskId) }),
  ...(after && { after: after.map(asTaskId) }),
  ...(plan_task !== undefined && { plan_task: asTaskId(plan_task) }),
});

export const API_BASE: string = import.meta.env.VITE_AGENTDECK_API ?? 'http://127.0.0.1:4317';

/** What the daemon refused, with its reason as the message. */
export class ApiError extends Error {}
/** The daemon could not be reached. */
export class OfflineError extends ApiError {
  constructor() {
    super('offline');
  }
}

/** True for the error a call throws when the daemon can't be reached. */
export const isOffline = (e: unknown) => e instanceof OfflineError;

async function call<T>(method: string, path: string, json?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new OfflineError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}
const get = <T>(path: string) => call<T>('GET', path);
const post = <T>(path: string, json?: unknown) => call<T>('POST', path, json);
const del = <T>(path: string) => call<T>('DELETE', path);

/** `?a=1&b=2` from the params that are set (null and undefined are left out; '' is sent), or '' when none are. */
function qs(params: Record<string, string | number | null | undefined>): string {
  const set = Object.entries(params).flatMap(([k, v]) => (v === null || v === undefined ? [] : [[k, String(v)]]));
  return set.length ? `?${new URLSearchParams(set)}` : '';
}

export const api = {
  // ---- The daemon and its settings
  status: () => get<Status>('/api/status'),
  pause: () => post<Status>('/api/pause'),
  resume: () => post<Status>('/api/resume'),
  /** Exit once nothing is running so launchd starts the daemon on the new code. `waiting` says what it waits for. */
  restartDaemon: () => post<RestartResult>('/api/daemon/restart'),
  /** Restart at once: the running tasks lose their run and are requeued. */
  restartDaemonNow: () => post<RestartNowResult>('/api/daemon/restart-now'),
  daemonState: () => get<DaemonState>('/api/daemon'),
  /** `agentdeck doctor`, the checkout's HEAD, what is running and the last lines of the daemon log. */
  daemonHealth: () => get<DaemonHealth>('/api/daemon/health'),
  service: () => get<ServiceStatus>('/api/service'),
  settings: () => get<Settings>('/api/settings'),
  updateSettings: (patch: SettingsPatch) => post<Settings>('/api/settings', patch),
  testNotify: () => post<TestNotifyResult>('/api/notify/test'),
  /** The scorecard per week (what `agentdeck stats --by week --json` prints), for one repo name or all. */
  stats: (repo: string | null) => get<Stats>(`/api/stats${qs({ by: 'week', repo })}`),

  // ---- Repos
  repos: () => get<Repo[]>('/api/repos'),
  archivedRepos: () => get<Repo[]>('/api/repos?archived=1'),
  addRepo: (r: NewRepo) => post<Repo>('/api/repos', r),
  repo: (id: number) => get<RepoDetail>(`/api/repos/${id}`),
  updateRepo: (id: number, patch: RepoPatch) => post<RepoDetail>(`/api/repos/${id}`, patch),
  propose: (id: number) => post<ProposalResult>(`/api/repos/${id}/propose`),
  doctor: (id: number) => post<DoctorReport>(`/api/repos/${id}/doctor`),
  resumeRepo: (id: number) => post<Repo>(`/api/repos/${id}/resume`),
  archiveRepo: (id: number) => post<Repo>(`/api/repos/${id}/archive`),
  unarchiveRepo: (id: number) => post<Repo>(`/api/repos/${id}/unarchive`),
  repoDeletion: (id: number) => get<RepoDeletion>(`/api/repos/${id}/deletion`),
  /** Local only: `leftover` names files that couldn't be removed. */
  deleteRepo: (id: number) => del<RepoDeleted>(`/api/repos/${id}`),

  // ---- Tasks
  tasks: () => get<TaskSummary[]>('/api/tasks'),
  task: (id: number) => get<TaskDetail>(`/api/tasks/${id}`),
  addTask: (t: NewTaskInput) => post<TaskSaved>('/api/tasks', brandNewTask(t)),
  editTask: (id: number, patch: TaskPatch) => post<TaskSaved>(`/api/tasks/${id}`, patch),
  approve: (id: number) => post<TaskDetail>(`/api/tasks/${id}/approve`),
  reject: (id: number) => post<TaskDetail>(`/api/tasks/${id}/reject`),
  cancel: (id: number) => post<CancelResult>(`/api/tasks/${id}/cancel`),
  /** `note` is "request changes": kept on the timeline and put first in the next run's prompt. */
  retry: (id: number, note?: string) => post<TaskDetail>(`/api/tasks/${id}/retry`, { note } satisfies RetryRequest),
  /** A person finished a blocked or failed task themselves; `note` is kept on the timeline. */
  markDone: (id: number, note?: string) => post<TaskDetail>(`/api/tasks/${id}/done`, { note } satisfies MarkDoneRequest),
  /** Install the packages a blocked task asked for (NEEDS deps) on its branch, then retry it. */
  installNeeds: (id: number) => post<TaskDetail>(`/api/tasks/${id}/install-needs`),
  /** Link the task to another; refused (a cycle, itself, already linked) with the reason as the error. */
  linkTask: (id: number, link: Omit<NewLink, 'on'> & { on: number }) =>
    post<TaskDetail>(`/api/tasks/${id}/links`, { ...link, on: asTaskId(link.on) } satisfies NewLink),
  unlinkTask: (id: number, on: number) => del<TaskDetail>(`/api/tasks/${id}/links/${on}`),
  /** Merge the base branch into the task's branch; a conflict starts a claude run, so this can take minutes. */
  sync: (id: number) => post<SyncResult>(`/api/tasks/${id}/sync`),
  /** Start a verify run on a proposed or queued task; the answer is at once, and the run's row says how it goes. */
  verify: (id: number) => post<VerifyResult>(`/api/tasks/${id}/verify`),
  /** How stale a proposed or queued task is, its named paths not on the base, and the open tasks touching the same files. */
  proposalCheck: (id: number) => get<ProposalCheck>(`/api/tasks/${id}/proposal-check`),
  planHtml: (id: number, planId: number) => get<PlanHtml>(`/api/tasks/${id}/plans/${planId}`),
  logUrl: (id: number, runId?: number) => `${API_BASE}/api/tasks/${id}/log${qs({ run: runId || null })}`,

  // ---- Pull requests and merging
  /** Push a done task's branch and open its PR (one that failed to open, or was closed); refused with the reason as the error. */
  openPr: (id: number) => post<OpenPrResult>(`/api/tasks/${id}/open-pr`),
  closePr: (id: number) => post<TaskDetail>(`/api/tasks/${id}/close-pr`),
  /** Retry the task with its PR's failing checks, and their logs, in the note; refused with the reason as the error. */
  fixChecks: (id: number) => post<FixChecksResult>(`/api/tasks/${id}/fix-checks`),
  mergePreview: (id: number) => get<MergePreview>(`/api/tasks/${id}/merge`),
  merge: (id: number, body: MergeRequest) => post<MergeResult>(`/api/tasks/${id}/merge`, body),
  /** Ask the daemon to merge the task's PR once it is ready; the answer is at once. */
  requestMerge: (id: number, body: RequestMergeRequest = {}) => post<RequestMergeResult>(`/api/tasks/${id}/merge-request`, body),
  /** Request these tasks' merges, each with its own method; the ones it could not request come back with why. */
  requestMerges: (ids: number[]) =>
    post<RequestMergesResult>('/api/tasks/merge-requests', { ids: ids.map(asTaskId) } satisfies RequestMergesRequest),
  /** Drop the task's merge request; the PR stays open. */
  cancelMergeRequest: (id: number) => del<CancelMergeRequestResult>(`/api/tasks/${id}/merge-request`),
  /** Let the daemon merge the task's PR on its own (true), not (false), or follow the repo (null). */
  autoMerge: (id: number, body: AutoMergeRequest) => post<AutoMergeResult>(`/api/tasks/${id}/auto-merge`, body),

  // ---- Changes and files
  /** The task's changes against the base, or since a commit on its branch (one of `since_points`). */
  changes: (id: number, since: string | null = null) => get<Changes>(`/api/tasks/${id}/changes${qs({ since })}`),
  diff: (id: number, path: string, since: string | null = null) => get<FilePatch>(`/api/tasks/${id}/diff${qs({ path, since })}`),
  tree: (id: number, ref: FileRef, path = '') => get<TreeListing>(`/api/tasks/${id}/tree${qs({ ref, path })}`),
  file: (id: number, ref: FileRef, path: string) => get<FileContent>(`/api/tasks/${id}/file${qs({ ref, path })}`),

  // ---- Reviews
  reviews: (id: number) => get<Review[]>(`/api/tasks/${id}/reviews`),
  /** The task's draft review, started if it has none. */
  startReview: (id: number) => post<Review>(`/api/tasks/${id}/reviews`),
  /** Change a draft's overall note. */
  editReview: (id: number, body: string) => post<Review>(`/api/reviews/${id}`, { body } satisfies ReviewPatch),
  addComment: (reviewId: number, c: NewReviewComment) => post<Review>(`/api/reviews/${reviewId}/comments`, c),
  deleteComment: (id: number) => del<Review>(`/api/review-comments/${id}`),
  /** Request changes also retries the task with the review as the reason. */
  submitReview: (id: number, body: SubmitReview) => post<Review>(`/api/reviews/${id}/submit`, body),
  resolveComment: (id: number) => post<Review>(`/api/review-comments/${id}/resolve`),
  reopenComment: (id: number) => post<Review>(`/api/review-comments/${id}/reopen`),
};

/** The call behind each thing a person may do to a task, for the row buttons, the hotkeys, the palette and the bulk bar. */
export const PERSON_CALLS: Record<PersonEvent, (id: number) => Promise<unknown>> = {
  approve: api.approve,
  reject: api.reject,
  retry: (id) => api.retry(id),
  cancel: api.cancel,
  mark_done: (id) => api.markDone(id),
};
