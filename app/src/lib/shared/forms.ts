// How the repo editor and the settings form map to and from what the API sends. Pure, so the
// panels only hold the form's state.
import type { MergeMethod, NotifyKind, RepoDetail, RepoPatch, Settings, SettingsPatch } from '../../api/types';
import { DEFAULT_AUTO_MERGE_SKIP } from '../../../../daemon/src/domain/landing/index.ts';
import { NOTIFY_KINDS } from '../../../../daemon/src/domain/operations/index.ts';
import { parseToolRules } from '../../../../daemon/src/domain/repos/index.ts';
import { parseTextList, textList } from '../../../../daemon/src/domain/shared/index.ts';
import { MODELS } from '../../../../daemon/src/domain/work/index.ts';

export { NOTIFY_KINDS };

export type RepoForm = {
  goals: string;
  autoApprove: boolean;
  testCmd: string;
  mergeMethod: MergeMethod;
  autoResolve: boolean;
  autoUnblock: boolean;
  autoMerge: boolean;
  autoMergeMaxLines: number;
  /** Path prefixes, comma-separated. */
  autoMergeSkip: string;
  sandbox: boolean;
  /** Hosts, comma-separated. */
  network: string;
  /** The model a new task of the repo takes when it names none; '' follows the default_model setting. */
  model: string;
  /** The repo's own tool rules, one per line; empty = the detected ones. */
  tools: string;
};

/** The models a model picker offers: the aliases, and `current` too when it is a full claude-… id set elsewhere. */
export const modelChoices = (current: string | null | undefined): string[] =>
  current && !MODELS.includes(current) ? [...MODELS, current] : MODELS;

export function toRepoForm(d: RepoDetail): RepoForm {
  return {
    goals: d.goals,
    autoApprove: !!d.auto_approve,
    testCmd: d.test_cmd ?? '',
    mergeMethod: d.merge_method,
    autoResolve: !!d.auto_resolve,
    autoUnblock: !!d.auto_unblock,
    autoMerge: !!d.auto_merge,
    autoMergeMaxLines: d.auto_merge_max_lines,
    autoMergeSkip: parseTextList(d.auto_merge_skip, DEFAULT_AUTO_MERGE_SKIP).join(', '),
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
    test_cmd: f.testCmd,
    merge_method: f.mergeMethod,
    auto_resolve: f.autoResolve,
    auto_unblock: f.autoUnblock,
    auto_merge: f.autoMerge,
    auto_merge_max_lines: f.autoMergeMaxLines,
    auto_merge_skip: textList(f.autoMergeSkip),
    sandbox: f.sandbox,
    network: textList(f.network),
    model: f.model || null,
    allowed_tools: parseToolRules(f.tools),
  };
}

// Edited as whole percentages, stored as 0..1.
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
