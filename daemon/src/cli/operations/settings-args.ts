// Argument handling for `agentdeck set` and `agentdeck repo set`: the key and value a person typed become a typed patch.
import { ActionError, type RepoPatch, type SettingsPatch } from '#application/actions.ts';
import { CAPACITY_REPO_SETTINGS, CAPACITY_SETTINGS } from '#cli/capacity/settings.ts';
import { LANDING_REPO_SETTINGS, LANDING_SETTINGS } from '#cli/landing/settings.ts';
import { OPERATIONS_SETTINGS } from '#cli/operations/settings.ts';
import { PROPOSALS_SETTINGS } from '#cli/proposals/settings.ts';
import { REPOS_REPO_SETTINGS } from '#cli/repos/settings.ts';
import { RUNS_REPO_SETTINGS, RUNS_SETTINGS } from '#cli/runs/settings.ts';
import { WORK_REPO_SETTINGS, WORK_SETTINGS } from '#cli/work/settings.ts';
import { MERGE_METHODS, PR_MODES } from '#domain/repos/index.ts';
import { MODELS } from '#domain/work/index.ts';

const SETTINGS = [CAPACITY_SETTINGS, OPERATIONS_SETTINGS, PROPOSALS_SETTINGS, RUNS_SETTINGS, LANDING_SETTINGS, WORK_SETTINGS];
const REPO_SETTINGS = [REPOS_REPO_SETTINGS, RUNS_REPO_SETTINGS, LANDING_REPO_SETTINGS, CAPACITY_REPO_SETTINGS, WORK_REPO_SETTINGS];

function findParser<P>(groups: Record<string, (value: string, key: string) => P>[], key: string | undefined) {
  if (key === undefined) return undefined;
  const group = groups.find((g) => Object.hasOwn(g, key));
  return group?.[key];
}

export function settingPatch(key: string | undefined, value: string): SettingsPatch {
  const parse = findParser(SETTINGS, key);
  if (key === undefined || !parse) throw new ActionError(`unknown setting "${key}"; see agentdeck help`);
  return parse(value, key);
}

const REPO_SETTING_USAGE = `usage: agentdeck repo set <repo> auto_approve on|off | auto_resolve on|off | auto_unblock on|off | auto_review on|off | escalate on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode ${PR_MODES.join('|')} | merge_method ${MERGE_METHODS.join('|')} | sandbox on|off | network "<hosts>" | auto_merge on|off | auto_merge_max_lines <n> | auto_merge_skip "<prefixes>" | ci_not_run_ok on|off | code_comment_max_lines <n> | code_comment_max_percent <n> | union_paths "<globs>" | generated_paths "<globs>" | generated_cmd "<cmd>" | max_concurrent <n> | issues on|off | issues_allow "<logins>" | model ${MODELS.join('|')}|"" | tools "<rules>"`;

export function repoSettingPatch(key: string | undefined, value: string): RepoPatch {
  const parse = findParser(REPO_SETTINGS, key);
  if (key === undefined || !parse) throw new ActionError(REPO_SETTING_USAGE);
  return parse(value, key);
}
