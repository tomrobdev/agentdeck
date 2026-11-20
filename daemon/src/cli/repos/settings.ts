// The parsing of the repo's own settings: approval, branch, commands and pull request mode.
import { type RepoPatch, onOff } from '#application/actions.ts';
import type { MergeMethod, PrMode } from '#domain/repos/index.ts';

export const REPOS_REPO_SETTINGS: Record<string, (value: string, key: string) => RepoPatch> = {
  pr_mode: (value) => ({ pr_mode: value as PrMode }),
  merge_method: (value) => ({ merge_method: value as MergeMethod }),
  auto_approve: (value, key) => ({ auto_approve: onOff(key, value) }),
  base_branch: (value) => ({ base_branch: value }),
  setup_cmd: (value) => ({ setup_cmd: value }),
  test_cmd: (value) => ({ test_cmd: value }),
};
