// Argument handling for `agentdeck set` and `agentdeck repo set`: the key and value a person typed become a typed patch.
import { ActionError, type RepoPatch, type SettingsPatch, onOff } from '../application/actions.ts';
import type { NotifyKind } from '../domain/operations/index.ts';
import { MERGE_METHODS, type MergeMethod, PR_MODES, type PrMode } from '../domain/repos/index.ts';
import { BUDGET_KEYS } from '../domain/capacity/index.ts';

/** The patch `agentdeck set <key> <value>` stands for. Throws ActionError for a key it does not know. */
export function settingPatch(key: string | undefined, value: string): SettingsPatch {
  if (key === 'max_concurrent') return { max_concurrent: Number(value) };
  if (key && (BUDGET_KEYS as string[]).includes(key)) return { budget: { [key]: Number(value) } };
  if (key === 'notify_desktop') return { notify: { desktop: onOff(key, value) } };
  if (key === 'notify_events') {
    const events = value
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    return { notify: { events: events as NotifyKind[] } };
  }
  if (key === 'ntfy_topic' || key === 'ntfy_server') return { notify: { [key]: value } };
  if (key === 'reload_on_change') return { reload_on_change: onOff(key, value) };
  if (key === 'planner_enabled') return { planner: { enabled: onOff(key, value) } };
  if (key === 'planner_interval_hours') return { planner: { interval_hours: Number(value) } };
  if (key === 'planner_max_tasks') return { planner: { max_tasks: Number(value) } };
  if (key === 'planner_model') return { planner: { model: value } };
  throw new ActionError(`unknown setting "${key}"; see agentdeck help`);
}

const REPO_SETTING_USAGE = `usage: agentdeck repo set <repo> auto_approve on|off | auto_resolve on|off | auto_unblock on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode ${PR_MODES.join('|')} | merge_method ${MERGE_METHODS.join('|')} | sandbox on|off | network "<hosts>" | auto_merge on|off | auto_merge_max_lines <n> | auto_merge_skip "<prefixes>" | tools "<rules>"`;

/** The patch `agentdeck repo set <repo> <key> <value>` stands for. Throws ActionError for a key it does not know. */
export function repoSettingPatch(key: string | undefined, value: string): RepoPatch {
  if (key === 'pr_mode') return { pr_mode: value as PrMode };
  if (key === 'merge_method') return { merge_method: value as MergeMethod };
  if (key === 'auto_approve') return { auto_approve: onOff(key, value) };
  if (key === 'auto_resolve') return { auto_resolve: onOff(key, value) };
  if (key === 'auto_unblock') return { auto_unblock: onOff(key, value) };
  if (key === 'auto_merge') return { auto_merge: onOff(key, value) };
  if (key === 'auto_merge_max_lines') return { auto_merge_max_lines: Number(value) };
  if (key === 'auto_merge_skip') return { auto_merge_skip: value };
  if (key === 'sandbox') return { sandbox: onOff(key, value) };
  if (key === 'network') return { network: value };
  if (key === 'base_branch') return { base_branch: value };
  if (key === 'setup_cmd') return { setup_cmd: value };
  if (key === 'test_cmd') return { test_cmd: value };
  // "" goes back to the rules detected from the toolchain.
  if (key === 'tools') return { allowed_tools: value };
  throw new ActionError(REPO_SETTING_USAGE);
}
