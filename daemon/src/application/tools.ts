import { rootInfo } from '../adapters/repo-root.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { allowedTools } from '../domain/repo/tools.ts';

/** The tool rules a worker gets in `dir`, a checkout of `repo` (see domain/repo/tools.ts). */
export function effectiveTools(repo: Repo, dir: string): string[] {
  return allowedTools(repo, rootInfo(dir));
}
