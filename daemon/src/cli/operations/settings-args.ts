// Argument handling for `agentdeck set` and `agentdeck repo set`: the key and value a person typed become a typed patch.
import { ActionError, type RepoPatch, type SettingsPatch, onOff } from '#application/actions.ts';
import type { NotifyKind } from '#domain/operations/index.ts';
import { MERGE_METHODS, type MergeMethod, PR_MODES, type PrMode } from '#domain/repos/index.ts';
import { BUDGET_KEYS } from '#domain/capacity/index.ts';
import { MODELS } from '#domain/work/index.ts';

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
  if (key === 'default_model' || key === 'support_model' || key === 'review_model') return { [key]: value };
  if (key === 'review_due_days') return { review_due: { days: Number(value) } };
  if (key === 'review_due_lines') return { review_due: { lines: Number(value) } };
  if (key === 'plan_branch_sync_minutes') return { plan_branch_sync_minutes: Number(value) };
  throw new ActionError(`unknown setting "${key}"; see agentdeck help`);
}

const REPO_SETTING_USAGE = `usage: agentdeck repo set <repo> auto_approve on|off | auto_resolve on|off | auto_unblock on|off | auto_review on|off | escalate on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode ${PR_MODES.join('|')} | merge_method ${MERGE_METHODS.join('|')} | sandbox on|off | network "<hosts>" | auto_merge on|off | auto_merge_max_lines <n> | auto_merge_skip "<prefixes>" | ci_not_run_ok on|off | code_comment_max_lines <n> | code_comment_max_percent <n> | model ${MODELS.join('|')}|"" | tools "<rules>"`;

export function repoSettingPatch(key: string | undefined, value: string): RepoPatch {
  if (key === 'pr_mode') return { pr_mode: value as PrMode };
  if (key === 'merge_method') return { merge_method: value as MergeMethod };
  if (key === 'auto_approve') return { auto_approve: onOff(key, value) };
  if (key === 'auto_resolve') return { auto_resolve: onOff(key, value) };
  if (key === 'auto_unblock') return { auto_unblock: onOff(key, value) };
  if (key === 'auto_review') return { auto_review: onOff(key, value) };
  if (key === 'escalate') return { escalate: onOff(key, value) };
  if (key === 'auto_merge') return { auto_merge: onOff(key, value) };
  if (key === 'auto_merge_max_lines') return { auto_merge_max_lines: Number(value) };
  if (key === 'auto_merge_skip') return { auto_merge_skip: value };
  if (key === 'ci_not_run_ok') return { ci_not_run_ok: onOff(key, value) };
  if (key === 'code_comment_max_lines') return { code_comment_max_lines: Number(value) };
  if (key === 'code_comment_max_percent') return { code_comment_max_percent: Number(value) };
  if (key === 'sandbox') return { sandbox: onOff(key, value) };
  if (key === 'network') return { network: value };
  if (key === 'base_branch') return { base_branch: value };
  if (key === 'setup_cmd') return { setup_cmd: value };
  if (key === 'test_cmd') return { test_cmd: value };
  if (key === 'model') return { model: value || null };
  if (key === 'tools') return { allowed_tools: value };
  throw new ActionError(REPO_SETTING_USAGE);
}
