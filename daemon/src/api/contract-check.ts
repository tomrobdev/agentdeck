// Each route names the contract type it answers with (route<T> in http.ts), so a use case whose return type drifts from
// what the dashboard reads fails `pnpm typecheck` there. This file checks the rest: each request type the dashboard sends
// must fit the parameter the use case takes, and the parts of a response checked on their own so a drift is reported
// where it is. The contract may name fewer fields than the use case returns.
import type { LogEntry as DomainLogEntry } from '../domain/runs/translate/log.ts';
import * as actions from '../application/actions.ts';
import type * as C from './contract.ts';

/** What a use case resolves to, whether it is async or not. */
type Out<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
/** The `n`th parameter of a use case. */
type In<F extends (...args: never[]) => unknown, N extends number> = Parameters<F>[N];
export const check = <_T extends true>(): true => true;
type Fits<Actual, Contract> = [Actual] extends [Contract] ? true : false;

// Parts of responses
check<Fits<DomainLogEntry, C.LogEntry>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['live']>, C.LiveView>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['sync']>, C.SyncView>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['merge_request']>, C.MergeRequestView>>();
check<Fits<Out<typeof actions.taskViews>[number]['conflicting'], NonNullable<C.TaskSummary['conflicting']>>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['checks']>, C.ChecksSummary>>();
check<Fits<NonNullable<Out<typeof actions.taskDetail>['check_list']>['checks'][number], C.PrCheck>>();

// Requests
check<Fits<C.NewRepo, In<typeof actions.addRepo, 1>>>();
check<Fits<C.RepoPatch, In<typeof actions.updateRepo, 2>>>();
check<Fits<C.NewTask, In<typeof actions.addTask, 1>>>();
check<Fits<C.TaskPatch, In<typeof actions.editTask, 2>>>();
check<Fits<C.NewLink, In<typeof actions.linkTasks, 2>>>();
check<Fits<C.SettingsPatch, In<typeof actions.updateSettings, 1>>>();
check<Fits<C.MergeRequest, In<typeof actions.mergeTask, 2>>>();
check<Fits<C.AutoMergeRequest, In<typeof actions.setAutoMerge, 2>>>();
check<Fits<C.RequestMergeRequest, In<typeof actions.requestMerge, 2>>>();
check<Fits<C.RequestMergesRequest, In<typeof actions.requestMerges, 1>>>();
check<Fits<C.ReviewPatch, In<typeof actions.editReview, 2>>>();
check<Fits<C.NewReviewComment, In<typeof actions.addReviewComment, 2>>>();
check<Fits<C.SubmitReview, In<typeof actions.submitReview, 2>>>();
check<Fits<C.RetryRequest['note'], In<typeof actions.retryTask, 2>>>();
check<Fits<C.MarkDoneRequest['note'], In<typeof actions.markDone, 2>>>();
