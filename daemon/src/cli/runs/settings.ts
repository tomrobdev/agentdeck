import { type RepoPatch, type SettingsPatch, onOff } from '#application/actions.ts';

export const RUNS_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  default_model: (value, key) => ({ [key]: value }),
  support_model: (value, key) => ({ [key]: value }),
  review_model: (value, key) => ({ [key]: value }),
};

export const RUNS_REPO_SETTINGS: Record<string, (value: string, key: string) => RepoPatch> = {
  auto_resolve: (value, key) => ({ auto_resolve: onOff(key, value) }),
  auto_unblock: (value, key) => ({ auto_unblock: onOff(key, value) }),
  auto_review: (value, key) => ({ auto_review: onOff(key, value) }),
  escalate: (value, key) => ({ escalate: onOff(key, value) }),
  sandbox: (value, key) => ({ sandbox: onOff(key, value) }),
  network: (value) => ({ network: value }),
  model: (value) => ({ model: value || null }),
  tools: (value) => ({ allowed_tools: value }),
};
