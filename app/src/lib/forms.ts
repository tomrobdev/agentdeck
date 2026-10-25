// How the repo editor and the settings form map to and from what the API sends. Pure, so the
// panels only hold the form's state.
import type { MergeMethod, NotifyKind, RepoDetail, RepoPatch, Settings, SettingsPatch } from '../api';

export type RepoForm = {
  goals: string;
  autoApprove: boolean;
  testCmd: string;
  mergeMethod: MergeMethod;
  autoResolve: boolean;
  sandbox: boolean;
  /** Hosts, comma-separated. */
  network: string;
};

/** The repo's `network` column: a JSON array of hosts. */
export function parseHosts(json: string | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

export function toRepoForm(d: RepoDetail): RepoForm {
  return {
    goals: d.goals,
    autoApprove: !!d.auto_approve,
    testCmd: d.test_cmd ?? '',
    mergeMethod: d.merge_method,
    autoResolve: !!d.auto_resolve,
    sandbox: !!d.sandbox,
    network: parseHosts(d.network).join(', '),
  };
}

export function toRepoPatch(f: RepoForm): RepoPatch {
  return {
    goals: f.goals,
    auto_approve: f.autoApprove,
    test_cmd: f.testCmd,
    merge_method: f.mergeMethod,
    auto_resolve: f.autoResolve,
    sandbox: f.sandbox,
    network: f.network.split(/[\s,]+/).filter(Boolean),
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
    reload_on_change: s.reload_on_change,
  };
}

export function toSettingsPatch(f: SettingsForm): SettingsPatch {
  return {
    max_concurrent: f.max_concurrent,
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
