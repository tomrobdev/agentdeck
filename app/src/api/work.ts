// Work: tasks, their links, plans, changes and files, and what a person may do to a task.
import { queryOptions } from '@tanstack/vue-query';
import { asTaskId } from '../../../daemon/src/domain/shared/index.ts';
import type { PersonEvent } from '../../../daemon/src/domain/work/index.ts';
import { atCommit, del, get, post, qs } from './http.ts';
import type {
  CancelResult,
  Changes,
  FileContent,
  FilePatch,
  FileRef,
  MarkDoneRequest,
  NewLink,
  NewTask,
  PlanHtml,
  ProposalCheck,
  RetryRequest,
  TaskDetail,
  TaskPatch,
  TaskSaved,
  TaskSummary,
  TreeListing,
} from './types.ts';

// The dashboard keeps ids as numbers (from the URL, from typing); a request body brands them here, where they enter the API.
type NewTaskInput = Omit<NewTask, 'builds_on' | 'after' | 'plan_task'> & { builds_on?: number[]; after?: number[]; plan_task?: number };
const brandNewTask = ({ builds_on, after, plan_task, ...rest }: NewTaskInput): NewTask => ({
  ...rest,
  ...(builds_on && { builds_on: builds_on.map(asTaskId) }),
  ...(after && { after: after.map(asTaskId) }),
  ...(plan_task !== undefined && { plan_task: asTaskId(plan_task) }),
});

export const workApi = {
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
  /** How stale a proposed or queued task is, its named paths not on the base, and the open tasks touching the same files. */
  proposalCheck: (id: number) => get<ProposalCheck>(`/api/tasks/${id}/proposal-check`),
  planHtml: (id: number, planId: number) => get<PlanHtml>(`/api/tasks/${id}/plans/${planId}`),

  // ---- Changes and files
  /** The task's changes against the base, or since a commit on its branch (one of `since_points`). */
  changes: (id: number, since: string | null = null) => get<Changes>(`/api/tasks/${id}/changes${qs({ since })}`),
  diff: (id: number, path: string, since: string | null = null) => get<FilePatch>(`/api/tasks/${id}/diff${qs({ path, since })}`),
  tree: (id: number, ref: FileRef, path = '') => get<TreeListing>(`/api/tasks/${id}/tree${qs({ ref, path })}`),
  file: (id: number, ref: FileRef, path: string) => get<FileContent>(`/api/tasks/${id}/file${qs({ ref, path })}`),
};

/** The call behind each thing a person may do to a task, for the row buttons, the hotkeys, the palette and the bulk bar. */
export const PERSON_CALLS: Record<PersonEvent, (id: number) => Promise<unknown>> = {
  approve: workApi.approve,
  reject: workApi.reject,
  retry: (id) => workApi.retry(id),
  cancel: workApi.cancel,
  mark_done: (id) => workApi.markDone(id),
};

// ---- Tasks
export const tasksQuery = () => queryOptions({ queryKey: ['tasks'] as const, queryFn: workApi.tasks });
export const taskQuery = (id: number) => queryOptions({ queryKey: ['task', id] as const, queryFn: () => workApi.task(id) });
/** Read only while a proposed or queued task is shown: it reads git, so it is never part of the task's detail. */
export const proposalCheckQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'proposal-check'] as const, queryFn: () => workApi.proposalCheck(id) });
/** Keyed by the plan's `updated_at`, so an edited plan is fetched afresh. */
export const planHtmlQuery = (id: number, planId: number, updatedAt: string) =>
  queryOptions({ queryKey: ['task', id, 'plan', planId, updatedAt] as const, queryFn: () => workApi.planHtml(id, planId) });

// ---- Changes and files
export const changesQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'changes'] as const, queryFn: () => workApi.changes(id) });
/** The task's changes since a commit on its branch, keyed by the head the changes against the base were read at. */
export const changesSinceQuery = (id: number, since: string, head: string | null) =>
  queryOptions({ queryKey: ['task', id, 'changes', since, head] as const, queryFn: () => workApi.changes(id, since) });
export const treeQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({
    queryKey: ['at', commit, 'tree', id, ref, path] as const,
    queryFn: () => workApi.tree(id, ref, path),
    staleTime: atCommit(commit),
  });
export const fileQuery = (id: number, ref: FileRef, path: string, commit: string | null) =>
  queryOptions({
    queryKey: ['at', commit, 'file', id, ref, path] as const,
    queryFn: () => workApi.file(id, ref, path),
    staleTime: atCommit(commit),
  });
/** One file's patch at the head, against the base or since a commit on the branch. */
export const diffQuery = (id: number, path: string, head: string | null, since: string | null = null) =>
  queryOptions({
    queryKey: ['at', head, 'diff', id, path, since] as const,
    queryFn: () => workApi.diff(id, path, since),
    staleTime: atCommit(head),
  });
