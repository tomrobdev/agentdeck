// The repo entity. Pure: no I/O.
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
}
