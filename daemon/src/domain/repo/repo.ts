// The repo entity. Pure: no I/O.
import type { MergeMethod } from '../pull-request/merge.ts';
import type { PrMode } from '../pull-request/pr.ts';

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  /** Tool rules the repo set itself; null = the generic defaults plus the toolchain's rules. */
  allowed_tools: string[] | null;
  /** Planner tasks skip approval. */
  auto_approve: boolean;
  proposed_at: string | null;
  toolchain: string | null; // pnpm | yarn | npm | cargo | uv | go, null = not detected
  setup_cmd: string | null; // run in each worktree before claude
  paused_reason: string | null; // set = no task of this repo is claimed until `repo resume` or a passing doctor
  pr_mode: PrMode;
  merge_method: MergeMethod; // how a PR is merged from the app unless the person picks another
  /** The daemon starts a resolve run on its own when a branch conflicts with the base. */
  auto_resolve: boolean;
  /** The daemon starts an unblock run on its own when a task blocks (domain/run/unblock.ts); off by default. */
  auto_unblock: boolean;
  /** The agent's Bash commands run in Claude Code's sandbox (the default). */
  sandbox: boolean;
  archived_at: string | null; // set = hidden everywhere and its work stopped, until `repo unarchive`
  /** Hosts sandboxed commands may reach; none = empty. */
  network: string[];
  /** The daemon merges a done task's PR on its own when it passes the auto-merge check. */
  auto_merge: boolean;
  auto_merge_max_lines: number; // a PR changing more lines (additions + deletions) needs a person
  /** Path prefixes; a PR touching one needs a person. */
  auto_merge_skip: string[];
  created_at: string;
}

/** Why work on a repo stops on its own: the daemon's pause first, then the repo's. Null when neither is paused. */
export function pausedReason(daemonPaused: boolean, repo: Pick<Repo, 'paused_reason'>): string | null {
  if (daemonPaused) return 'AgentDeck is paused';
  return repo.paused_reason ? `the repo is paused: ${repo.paused_reason}` : null;
}
