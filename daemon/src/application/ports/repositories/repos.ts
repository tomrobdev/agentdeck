// Repos' repository: the registered repos and their settings.
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import type { Repo } from '#domain/repos/index.ts';

export interface NewRepo {
  name: string;
  path: string;
  base_branch: string;
  test_cmd?: string | null;
  allowed_tools?: string[] | null;
  toolchain?: string | null;
  setup_cmd?: string | null;
}

export type RepoUpdate = Partial<
  Pick<
    Repo,
    | 'auto_approve'
    | 'test_cmd'
    | 'setup_cmd'
    | 'proposed_at'
    | 'base_branch'
    | 'pr_mode'
    | 'merge_method'
    | 'auto_resolve'
    | 'auto_unblock'
    | 'auto_review'
    | 'escalate'
    | 'sandbox'
    | 'network'
    | 'auto_merge'
    | 'auto_merge_max_lines'
    | 'auto_merge_skip'
    | 'ci_not_run_ok'
    | 'code_comment_max_lines'
    | 'code_comment_max_percent'
    | 'model'
    | 'allowed_tools'
  >
>;

export interface RepoRepository {
  addRepo(r: NewRepo): Repo;
  getRepo(id: RepoId): Repo | undefined;
  findRepo(nameOrId: string): Repo | undefined;
  listRepos(opts?: { archived?: boolean }): Repo[];
  setRepoArchived(id: RepoId, archived: boolean): void;
  repoHasRunning(id: RepoId): boolean;
  repoFootprint(id: RepoId): {
    tasks: { id: TaskId; branch: string | null; worktree: string | null }[];
    run_logs: string[];
    planner_logs: string[];
  };
  deleteRepo(id: RepoId): boolean;
  updateRepo(id: RepoId, fields: RepoUpdate): void;
  setRepoPaused(id: RepoId, reason: string | null): void;
  pauseRepo(id: RepoId, reason: string): boolean;
}
