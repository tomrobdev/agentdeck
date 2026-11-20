import type { MergeMethod, NotifyKind, PrMode, RepoDetail, RepoPatch, Settings, SettingsPatch } from '#api/types.ts';
import { DEFAULT_AUTO_MERGE_SKIP, DEFAULT_CODE_COMMENT_MAX_LINES, DEFAULT_CODE_COMMENT_MAX_PERCENT } from '#daemon/domain/landing/index.ts';
import { parseToolRules } from '#daemon/domain/repos/index.ts';
import { parseTextList, textList } from '#daemon/domain/shared/index.ts';
import { MODELS } from '#daemon/domain/work/index.ts';

export type RepoForm = {
  goals: string;
  autoApprove: boolean;
  baseBranch: string;
  setupCmd: string;
  testCmd: string;
  prMode: PrMode;
  mergeMethod: MergeMethod;
  autoResolve: boolean;
  autoUnblock: boolean;
  autoReview: boolean;
  autoMerge: boolean;
  autoMergeMaxLines: number;
  autoMergeSkip: string;
  ciNotRunOk: boolean;
  codeCommentMaxLines: number;
  codeCommentMaxPercent: number;
  unionPaths: string;
  sandbox: boolean;
  network: string;
  model: string;
  tools: string;
};

export const modelChoices = (current: string | null | undefined): string[] =>
  current && !MODELS.includes(current) ? [...MODELS, current] : MODELS;

export function toRepoForm(d: RepoDetail): RepoForm {
  return {
    goals: d.goals,
    autoApprove: !!d.auto_approve,
    baseBranch: d.base_branch,
    setupCmd: d.setup_cmd ?? '',
    testCmd: d.test_cmd ?? '',
    prMode: d.pr_mode,
    mergeMethod: d.merge_method,
    autoResolve: !!d.auto_resolve,
    autoUnblock: !!d.auto_unblock,
    autoReview: !!d.auto_review,
    autoMerge: !!d.auto_merge,
    autoMergeMaxLines: d.auto_merge_max_lines,
    autoMergeSkip: parseTextList(d.auto_merge_skip, DEFAULT_AUTO_MERGE_SKIP).join(', '),
    ciNotRunOk: !!d.ci_not_run_ok,
    codeCommentMaxLines: d.code_comment_max_lines ?? DEFAULT_CODE_COMMENT_MAX_LINES,
    codeCommentMaxPercent: d.code_comment_max_percent ?? DEFAULT_CODE_COMMENT_MAX_PERCENT,
    unionPaths: parseTextList(d.union_paths).join(', '),
    sandbox: !!d.sandbox,
    network: parseTextList(d.network).join(', '),
    model: d.model ?? '',
    tools: d.allowed_tools === null ? '' : parseTextList(d.allowed_tools).join('\n'),
  };
}

export function toRepoPatch(f: RepoForm): RepoPatch {
  return {
    goals: f.goals,
    auto_approve: f.autoApprove,
    base_branch: f.baseBranch.trim(),
    setup_cmd: f.setupCmd,
    test_cmd: f.testCmd,
    pr_mode: f.prMode,
    merge_method: f.mergeMethod,
    auto_resolve: f.autoResolve,
    auto_unblock: f.autoUnblock,
    auto_review: f.autoReview,
    auto_merge: f.autoMerge,
    auto_merge_max_lines: f.autoMergeMaxLines,
    auto_merge_skip: textList(f.autoMergeSkip),
    ci_not_run_ok: f.ciNotRunOk,
    code_comment_max_lines: f.codeCommentMaxLines,
    code_comment_max_percent: f.codeCommentMaxPercent,
    union_paths: textList(f.unionPaths),
    sandbox: f.sandbox,
    network: textList(f.network),
    model: f.model || null,
    allowed_tools: parseToolRules(f.tools),
  };
}

export type SettingsForm = {
  max_concurrent: number;
  five_hour_max: number;
  five_hour_soft: number;
  weekly_max: number;
  pace_slack: number;
  desktop: boolean;
  events: NotifyKind[];
  ntfy_topic: string;
  planner_enabled: boolean;
  planner_interval_hours: number;
  planner_max_tasks: number;
  planner_model: string;
  default_model: string;
  support_model: string;
  reload_on_change: boolean;
};

const toPct = (x: number) => Math.round(x * 100);

export function toSettingsForm(s: Settings): SettingsForm {
  return {
    max_concurrent: s.max_concurrent,
    five_hour_max: toPct(s.budget.five_hour_max),
    five_hour_soft: toPct(s.budget.five_hour_soft),
    weekly_max: toPct(s.budget.weekly_max),
    pace_slack: toPct(s.budget.pace_slack),
    desktop: s.notify.desktop,
    events: [...s.notify.events],
    ntfy_topic: s.notify.ntfy_topic,
    planner_enabled: s.planner.enabled,
    planner_interval_hours: s.planner.interval_hours,
    planner_max_tasks: s.planner.max_tasks,
    planner_model: s.planner.model,
    default_model: s.default_model,
    support_model: s.support_model,
    reload_on_change: s.reload_on_change,
  };
}

export function toSettingsPatch(f: SettingsForm): SettingsPatch {
  return {
    max_concurrent: f.max_concurrent,
    default_model: f.default_model,
    support_model: f.support_model,
    reload_on_change: f.reload_on_change,
    budget: {
      five_hour_max: f.five_hour_max / 100,
      five_hour_soft: f.five_hour_soft / 100,
      weekly_max: f.weekly_max / 100,
      pace_slack: f.pace_slack / 100,
    },
    notify: { desktop: f.desktop, events: f.events, ntfy_topic: f.ntfy_topic },
    planner: {
      enabled: f.planner_enabled,
      interval_hours: f.planner_interval_hours,
      max_tasks: f.planner_max_tasks,
      model: f.planner_model,
    },
  };
}
