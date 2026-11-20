// The parsing of the landing settings: auto-merge, code comment limits, area review dues and the sync's union and generated paths.
import { type RepoPatch, type SettingsPatch, onOff } from '#application/actions.ts';

export const LANDING_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  review_due_days: (value) => ({ review_due: { days: Number(value) } }),
  review_due_lines: (value) => ({ review_due: { lines: Number(value) } }),
};

export const LANDING_REPO_SETTINGS: Record<string, (value: string, key: string) => RepoPatch> = {
  auto_merge: (value, key) => ({ auto_merge: onOff(key, value) }),
  auto_merge_max_lines: (value) => ({ auto_merge_max_lines: Number(value) }),
  auto_merge_skip: (value) => ({ auto_merge_skip: value }),
  ci_not_run_ok: (value, key) => ({ ci_not_run_ok: onOff(key, value) }),
  code_comment_max_lines: (value) => ({ code_comment_max_lines: Number(value) }),
  code_comment_max_percent: (value) => ({ code_comment_max_percent: Number(value) }),
  union_paths: (value) => ({ union_paths: value }),
  generated_paths: (value) => ({ generated_paths: value }),
  generated_cmd: (value) => ({ generated_cmd: value }),
};
