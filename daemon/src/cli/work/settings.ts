import { type RepoPatch, type SettingsPatch, onOff } from '#application/actions.ts';

export const WORK_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  plan_branch_sync_minutes: (value) => ({ plan_branch_sync_minutes: Number(value) }),
  plan_branch_max_days: (value) => ({ plan_branch_max_days: Number(value) }),
  plan_branch_max_lines: (value) => ({ plan_branch_max_lines: Number(value) }),
};

export const WORK_REPO_SETTINGS: Record<string, (value: string, key: string) => RepoPatch> = {
  issues: (value, key) => ({ issues: onOff(key, value) }),
  issues_allow: (value) => ({ issues_allow: value }),
};
