// Work: tasks, their links, plans, changes and files, and what a person may do to a task.
import { queryOptions } from '@tanstack/vue-query';
import { asTaskId } from '#daemon/domain/shared/index.ts';
import type { PersonEvent } from '#daemon/domain/work/index.ts';
import { atCommit, del, get, post, qs } from '#api/http.ts';
import type {
  CancelResult,
  Changes,
  FileContent,
  FilePatch,
  FileRef,
  MarkDoneRequest,
  NewLink,
  NewTask,
  ParkRequest,
  PlanHtml,
  ProposalCheck,
  RetryRequest,
  TaskDetail,
  TaskPatch,
  TaskSaved,
  TaskSummary,
  TreeListing,
} from '#api/types.ts';

type NewTaskInput = Omit<NewTask, 'builds_on' | 'after' | 'plan_task'> & { builds_on?: number[]; after?: number[]; plan_task?: number };
const brandNewTask = ({ builds_on, after, plan_task, ...rest }: NewTaskInput): NewTask => ({
  ...rest,
  ...(builds_on && { builds_on: builds_on.map(asTaskId) }),
  ...(after && { after: after.map(asTaskId) }),
  ...(plan_task !== undefined && { plan_task: asTaskId(plan_task) }),
});

export const workApi = {
  tasks: () => get<TaskSummary[]>('/api/tasks'),
  task: (id: number) => get<TaskDetail>(`/api/tasks/${id}`),
  addTask: (t: NewTaskInput) => post<TaskSaved>('/api/tasks', brandNewTask(t)),
  editTask: (id: number, patch: TaskPatch) => post<TaskSaved>(`/api/tasks/${id}`, patch),
  approve: (id: number) => post<TaskDetail>(`/api/tasks/${id}/approve`),
  reject: (id: number) => post<TaskDetail>(`/api/tasks/${id}/reject`),
  park: (id: number, reason?: string) => post<TaskDetail>(`/api/tasks/${id}/park`, { reason } satisfies ParkRequest),
  lift: (id: number) => post<TaskDetail>(`/api/tasks/${id}/lift`),
  cancel: (id: number) => post<CancelResult>(`/api/tasks/${id}/cancel`),
  retry: (id: number, note?: string, max_turns?: number) =>
    post<TaskDetail>(`/api/tasks/${id}/retry`, { note, max_turns } satisfies RetryRequest),
  markDone: (id: number, note?: string) => post<TaskDetail>(`/api/tasks/${id}/done`, { note } satisfies MarkDoneRequest),
  installNeeds: (id: number) => post<TaskDetail>(`/api/tasks/${id}/install-needs`),
  linkTask: (id: number, link: Omit<NewLink, 'on'> & { on: number }) =>
    post<TaskDetail>(`/api/tasks/${id}/links`, { ...link, on: asTaskId(link.on) } satisfies NewLink),
  unlinkTask: (id: number, on: number) => del<TaskDetail>(`/api/tasks/${id}/links/${on}`),
  proposalCheck: (id: number) => get<ProposalCheck>(`/api/tasks/${id}/proposal-check`),
  planHtml: (id: number, planId: number) => get<PlanHtml>(`/api/tasks/${id}/plans/${planId}`),

  changes: (id: number, since: string | null = null) => get<Changes>(`/api/tasks/${id}/changes${qs({ since })}`),
  diff: (id: number, path: string, since: string | null = null) => get<FilePatch>(`/api/tasks/${id}/diff${qs({ path, since })}`),
  tree: (id: number, ref: FileRef, path = '') => get<TreeListing>(`/api/tasks/${id}/tree${qs({ ref, path })}`),
  file: (id: number, ref: FileRef, path: string) => get<FileContent>(`/api/tasks/${id}/file${qs({ ref, path })}`),
};

export const PERSON_CALLS: Record<PersonEvent, (id: number) => Promise<unknown>> = {
  approve: workApi.approve,
  reject: workApi.reject,
  park: (id) => workApi.park(id),
  lift: workApi.lift,
  retry: (id) => workApi.retry(id),
  cancel: workApi.cancel,
  mark_done: (id) => workApi.markDone(id),
};

export const tasksQuery = () => queryOptions({ queryKey: ['tasks'] as const, queryFn: workApi.tasks });
export const taskQuery = (id: number) => queryOptions({ queryKey: ['task', id] as const, queryFn: () => workApi.task(id) });
export const proposalCheckQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'proposal-check'] as const, queryFn: () => workApi.proposalCheck(id) });
export const planHtmlQuery = (id: number, planId: number, updatedAt: string) =>
  queryOptions({ queryKey: ['task', id, 'plan', planId, updatedAt] as const, queryFn: () => workApi.planHtml(id, planId) });

export const changesQuery = (id: number) =>
  queryOptions({ queryKey: ['task', id, 'changes'] as const, queryFn: () => workApi.changes(id) });
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
export const diffQuery = (id: number, path: string, head: string | null, since: string | null = null) =>
  queryOptions({
    queryKey: ['at', head, 'diff', id, path, since] as const,
    queryFn: () => workApi.diff(id, path, since),
    staleTime: atCommit(head),
  });
