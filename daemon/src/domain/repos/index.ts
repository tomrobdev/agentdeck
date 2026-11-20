// The repos context's interface: what other contexts and the layers above import.
export {
  EDITS_FOLDER,
  EDIT_LIMIT,
  NEVER_APPLIED,
  PROTECTED_PREFIXES,
  editPathFor,
  isProtectedPath,
  protectedEditTarget,
  protectedEditsMessage,
} from '#domain/repos/protected-edits.ts';
export { splitGenerated } from '#domain/repos/generated.ts';
export { AGENTDECK_FOLDER, DEFAULT_MERGE_METHOD, MERGE_METHODS, PR_MODES, isMergeMethod, pausedReason } from '#domain/repos/repo.ts';
export type { MergeMethod, PrMode, Repo } from '#domain/repos/repo.ts';
export { goalsError, networkError, repoNameError, toolRulesError } from '#domain/repos/rules.ts';
export { refusedCommands } from '#domain/repos/tool-rules.ts';
export { detectToolchain } from '#domain/repos/toolchain.ts';
export { planBranchCiWarning } from '#domain/repos/workflow-triggers.ts';
export type { WorkflowFile } from '#domain/repos/workflow-triggers.ts';
export { ALWAYS_DISALLOWED_TOOLS, allowedTools, parseToolRules, toolRulesSource } from '#domain/repos/tools.ts';
export type { ToolRulesSource } from '#domain/repos/tools.ts';
