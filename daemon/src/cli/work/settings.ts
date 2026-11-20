// The parsing of the plan branch settings.
import { type SettingsPatch } from '#application/actions.ts';

export const WORK_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  plan_branch_sync_minutes: (value) => ({ plan_branch_sync_minutes: Number(value) }),
  plan_branch_max_days: (value) => ({ plan_branch_max_days: Number(value) }),
  plan_branch_max_lines: (value) => ({ plan_branch_max_lines: Number(value) }),
};
