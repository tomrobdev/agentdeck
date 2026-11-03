// The repo entity. Pure: no I/O.
import type { MergeMethod } from '../pull-request/merge.ts';
import type { PrMode } from '../pull-request/pr.ts';

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  allowed_tools: string | null; // JSON array, null = generic defaults plus the toolchain's rules
  auto_approve: number; // 1 = planner tasks skip approval
  planned_at: string | null;
  toolchain: string | null; // pnpm | yarn | npm | cargo | uv | go, null = not detected
  setup_cmd: string | null; // run in each worktree before claude
  paused_reason: string | null; // set = no task of this repo is claimed until `repo resume` or a passing doctor
  pr_mode: PrMode;
  merge_method: MergeMethod; // how a PR is merged from the app unless the person picks another
  auto_resolve: number; // 1 = the daemon starts a resolve run on its own when a branch conflicts with the base
  auto_unblock: number; // 1 = the daemon starts an unblock run on its own when a task blocks (domain/run/unblock.ts); 0 by default
  sandbox: number; // 1 = the agent's Bash commands run in Claude Code's sandbox (the default)
  archived_at: string | null; // set = hidden everywhere and its work stopped, until `repo unarchive`
  network: string; // JSON array of hosts sandboxed commands may reach, '[]' = none
  auto_merge: number; // 1 = the daemon merges a done task's PR on its own when it passes the auto-merge check
  auto_merge_max_lines: number; // a PR changing more lines (additions + deletions) needs a person
  auto_merge_skip: string; // JSON array of path prefixes; a PR touching one needs a person
  created_at: string;
}

/** Why work on a repo stops on its own: the daemon's pause first, then the repo's. Null when neither is paused. */
export function pausedReason(daemonPaused: boolean, repo: Pick<Repo, 'paused_reason'>): string | null {
  if (daemonPaused) return 'AgentDeck is paused';
  return repo.paused_reason ? `the repo is paused: ${repo.paused_reason}` : null;
}
