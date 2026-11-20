import { type SettingsPatch, onOff } from '#application/actions.ts';

export const PROPOSALS_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  planner_enabled: (value, key) => ({ planner: { enabled: onOff(key, value) } }),
  planner_interval_hours: (value) => ({ planner: { interval_hours: Number(value) } }),
  planner_max_tasks: (value) => ({ planner: { max_tasks: Number(value) } }),
  planner_model: (value) => ({ planner: { model: value } }),
};
