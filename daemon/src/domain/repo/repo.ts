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
  sandbox: number; // 1 = the agent's Bash commands run in Claude Code's sandbox (the default)
  network: string; // JSON array of hosts sandboxed commands may reach, '[]' = none
}
