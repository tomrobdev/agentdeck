// A repo as the API and the dashboard see it: the flat shape of its columns (flags as 1 or 0, lists as JSON text), so neither changes with the domain's `Repo`.
import { type Repo, type ToolRulesSource, toolRulesSource } from '#domain/repos/index.ts';

export interface RepoView extends Omit<
  Repo,
  | 'allowed_tools'
  | 'auto_approve'
  | 'auto_resolve'
  | 'auto_unblock'
  | 'auto_review'
  | 'sandbox'
  | 'network'
  | 'auto_merge'
  | 'auto_merge_skip'
  | 'ci_not_run_ok'
  | 'union_paths'
  | 'generated_paths'
  | 'issues'
  | 'issues_allow'
> {
  allowed_tools: string | null;
  tools_source: ToolRulesSource;
  auto_approve: number;
  auto_resolve: number;
  auto_unblock: number;
  auto_review: number;
  sandbox: number;
  network: string;
  auto_merge: number;
  auto_merge_skip: string;
  ci_not_run_ok: number;
  union_paths: string;
  generated_paths: string;
  issues: number;
  issues_allow: string;
}

const bit = (on: boolean): number => (on ? 1 : 0);

export function repoView(repo: Repo): RepoView {
  return {
    ...repo,
    allowed_tools: repo.allowed_tools && JSON.stringify(repo.allowed_tools),
    tools_source: toolRulesSource(repo),
    auto_approve: bit(repo.auto_approve),
    auto_resolve: bit(repo.auto_resolve),
    auto_unblock: bit(repo.auto_unblock),
    auto_review: bit(repo.auto_review),
    sandbox: bit(repo.sandbox),
    network: JSON.stringify(repo.network),
    auto_merge: bit(repo.auto_merge),
    auto_merge_skip: JSON.stringify(repo.auto_merge_skip),
    ci_not_run_ok: bit(repo.ci_not_run_ok),
    issues: bit(repo.issues),
    issues_allow: JSON.stringify(repo.issues_allow),
    union_paths: JSON.stringify(repo.union_paths),
    generated_paths: JSON.stringify(repo.generated_paths),
  };
}
