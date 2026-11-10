// Each route names the contract type it answers with (route<T> in http.ts), so a use case whose return type drifts from what the dashboard reads fails `pnpm typecheck` there.
import type { LogEntry as DomainLogEntry } from '../domain/runs/index.ts';
import * as actions from '../application/actions.ts';
import type { NewRepo, RepoPatch } from './contract/repos.ts';
import type { MarkDoneRequest, NewLink, NewTask, RetryRequest, TaskPatch, TaskSummary } from './contract/work.ts';
import type { LiveView, RunSummary, SyncView, VerifyResult } from './contract/runs.ts';
import type {
  AutoMergeRequest,
  ChecksSummary,
  MergeRequest,
  MergeRequestView,
  NewReviewComment,
  PrCheck,
  RequestMergeRequest,
  RequestMergesRequest,
  ReviewPatch,
  SubmitReview,
} from './contract/landing.ts';
import type { LogEntry } from './contract/files.ts';
import type { SettingsPatch } from './contract/operations.ts';

type Out<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
type In<F extends (...args: never[]) => unknown, N extends number> = Parameters<F>[N];
export const check = <_T extends true>(): true => true;
type Fits<Actual, Contract> = [Actual] extends [Contract] ? true : false;

check<Fits<DomainLogEntry, LogEntry>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['live']>, LiveView>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['sync']>, SyncView>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['merge_request']>, MergeRequestView>>();
check<Fits<Out<typeof actions.taskViews>[number]['conflicting'], NonNullable<TaskSummary['conflicting']>>>();
check<Fits<NonNullable<Out<typeof actions.taskViews>[number]['checks']>, ChecksSummary>>();
check<Fits<NonNullable<Out<typeof actions.taskDetail>['check_list']>['checks'][number], PrCheck>>();
check<Fits<NonNullable<Out<typeof actions.taskDetail>['runs'][number]['summary']>, RunSummary>>();
check<Fits<Awaited<Out<typeof actions.startVerify>['done']>, NonNullable<VerifyResult['report']>>>();

check<Fits<NewRepo, In<typeof actions.addRepo, 1>>>();
check<Fits<RepoPatch, In<typeof actions.updateRepo, 2>>>();
check<Fits<NewTask, In<typeof actions.addTask, 1>>>();
check<Fits<TaskPatch, In<typeof actions.editTask, 2>>>();
check<Fits<NewLink, In<typeof actions.linkTasks, 2>>>();
check<Fits<SettingsPatch, In<typeof actions.updateSettings, 1>>>();
check<Fits<MergeRequest, In<typeof actions.mergeTask, 2>>>();
check<Fits<AutoMergeRequest, In<typeof actions.setAutoMerge, 2>>>();
check<Fits<RequestMergeRequest, In<typeof actions.requestMerge, 2>>>();
check<Fits<RequestMergesRequest, In<typeof actions.requestMerges, 1>>>();
check<Fits<ReviewPatch, In<typeof actions.editReview, 2>>>();
check<Fits<NewReviewComment, In<typeof actions.addReviewComment, 2>>>();
check<Fits<SubmitReview, In<typeof actions.submitReview, 2>>>();
check<Fits<RetryRequest, In<typeof actions.retryTask, 2>>>();
check<Fits<MarkDoneRequest['note'], In<typeof actions.markDone, 2>>>();
