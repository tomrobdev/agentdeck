// Each use case's return type must be assignable to the contract type the dashboard reads, and each request type the
// dashboard sends to the parameter the use case takes, so a change on one side that the other doesn't follow fails
// `pnpm typecheck`. The contract may name fewer fields than the use case returns.
import type { Db } from '../db/index.ts';
import type { LogEntry as DomainLogEntry } from '../domain/run/log.ts';
import * as actions from '../application/actions.ts';
import type * as C from './contract.ts';

/** What a use case resolves to, whether it is async or not. */
type Out<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
/** The `n`th parameter of a use case. */
type In<F extends (...args: never[]) => unknown, N extends number> = Parameters<F>[N];
export const check = <_T extends true>(): true => true;
type Fits<Actual, Contract> = [Actual] extends [Contract] ? true : false;
/** Without the `task` that the route adds. */
type WithoutTask<T> = Omit<T, 'task'>;

// Responses
check<Fits<Out<typeof actions.status>, C.Status>>();
check<Fits<Out<typeof actions.restartDaemon>, C.RestartResult>>();
check<Fits<Out<typeof actions.serviceStatus>, C.ServiceStatus>>();
check<Fits<Out<typeof actions.getSettings>, C.Settings>>();
check<Fits<Out<typeof actions.updateSettings>, C.Settings>>();
check<Fits<ReturnType<Db['listRepos']>, C.Repo[]>>();
check<Fits<Out<typeof actions.addRepo>, C.Repo>>();
check<Fits<Out<typeof actions.repoDetail>, C.RepoDetail>>();
check<Fits<Out<typeof actions.updateRepo>, C.RepoDetail>>();
check<Fits<Out<typeof actions.resumeRepo>, C.Repo>>();
check<Fits<Out<typeof actions.archiveRepo>, C.Repo>>();
check<Fits<Out<typeof actions.unarchiveRepo>, C.Repo>>();
check<Fits<Out<typeof actions.doctorRepo>, C.DoctorReport>>();
check<Fits<Out<typeof actions.repoDeletionPreview>, C.RepoDeletion>>();
check<Fits<Out<typeof actions.deleteRepo>, C.RepoDeleted>>();
check<Fits<Out<typeof actions.proposeNow>, C.ProposalResult>>();
check<Fits<Out<typeof actions.taskViews>[number], C.TaskSummary>>();
check<Fits<Out<typeof actions.taskDetail>, C.TaskDetail>>();
check<Fits<Out<typeof actions.cancelTask>, C.CancelResult['result']>>();
check<Fits<Out<typeof actions.mergePreview>, C.MergePreview>>();
check<Fits<Out<typeof actions.mergeTask>, WithoutTask<C.MergeResult>>>();
check<Fits<Out<typeof actions.setAutoMerge>, WithoutTask<C.AutoMergeResult>>>();
check<Fits<Out<typeof actions.syncNow>, WithoutTask<C.SyncResult>>>();
check<Fits<Out<typeof actions.taskChanges>, C.Changes>>();
check<Fits<Out<typeof actions.taskDiff>, C.FilePatch>>();
check<Fits<Out<typeof actions.taskTree>, C.TreeListing>>();
check<Fits<Out<typeof actions.taskFile>, C.FileContent>>();
check<Fits<Out<typeof actions.attachPlan>, C.TaskPlan>>();
check<Fits<Out<typeof actions.collectPlans>, C.TaskPlan[]>>();
check<Fits<Out<typeof actions.planHtml>, C.PlanHtml>>();
check<Fits<DomainLogEntry, C.LogEntry>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['live']>, C.LiveView>>();

// Requests
check<Fits<C.NewRepo, In<typeof actions.addRepo, 1>>>();
check<Fits<C.RepoPatch, In<typeof actions.updateRepo, 2>>>();
check<Fits<C.NewTask, In<typeof actions.addTask, 1>>>();
check<Fits<C.TaskPatch, In<typeof actions.editTask, 2>>>();
check<Fits<C.NewLink, In<typeof actions.linkTasks, 2>>>();
check<Fits<C.SettingsPatch, In<typeof actions.updateSettings, 1>>>();
check<Fits<C.MergeRequest, In<typeof actions.mergeTask, 2>>>();
check<Fits<C.AutoMergeRequest, In<typeof actions.setAutoMerge, 2>>>();
check<Fits<C.RetryRequest['note'], In<typeof actions.retryTask, 2>>>();
check<Fits<C.MarkDoneRequest['note'], In<typeof actions.markDone, 2>>>();
