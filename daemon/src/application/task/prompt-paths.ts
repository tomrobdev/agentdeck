// Warn when a task's prompt names a repo path that won't be there when the task runs.
import { branchCommit, objectAt, resolveCommit } from '../../adapters/git.ts';
import type { Db } from '../../db/index.ts';
import { linkState } from '../../domain/task/link.ts';
import { pathsNamedIn } from '../../domain/task/prompt-paths.ts';
import type { Task } from '../../domain/task/task.ts';
import { targetOf } from './dependencies.ts';
import { requireTask, requireTaskRepo } from '../input.ts';

/**
 * Warnings (never errors) for each path the task's prompt names that is not on its repo's base branch and that no task
 * it builds on adds: a worker told to follow a file that isn't there blocks. A task it builds on that is not merged yet
 * counts through its branch; with no branch yet, the path "may come from it". Checks the saved task, so call it after
 * addTask or editTask. Git trouble (no base commit, an unreadable repo) means no warnings, not a failure.
 */
export async function promptWarnings(db: Db, id: number): Promise<string[]> {
  const task = requireTask(db, id);
  const paths = pathsNamedIn(task.prompt);
  if (!paths.length) return [];
  try {
    const repo = requireTaskRepo(db, task);
    const base = (await resolveCommit(repo.path, repo.base_branch)) ?? (await resolveCommit(repo.path, `origin/${repo.base_branch}`));
    if (!base) return [];
    const sources = unmergedBuiltOn(db, task);
    const branchless = sources.filter((s) => !s.branch).map((s) => `#${s.id}`);
    const commits = (
      await Promise.all(
        sources.flatMap(async (s) => {
          const dep = db.getRepo(s.repo_id);
          const commit = dep && s.branch ? await branchCommit(dep.path, s.branch) : null;
          return dep && commit ? [{ path: dep.path, commit }] : [];
        }),
      )
    ).flat();
    const warnings: string[] = [];
    for (const named of paths) {
      const path = named.replace(/\/$/, ''); // a folder is looked up without its slash
      if (await objectAt(repo.path, base, path)) continue;
      if ((await Promise.all(commits.map((c) => objectAt(c.path, c.commit, path)))).some(Boolean)) continue;
      const missing = `the prompt names ${named}, which isn't on ${repo.base_branch}`;
      warnings.push(
        branchless.length
          ? `${missing}; ${branchless.join(', ')}, which it builds on, ${branchless.length > 1 ? 'have' : 'has'} no branch yet and may add it`
          : `${missing} and no task it builds on adds it`,
      );
    }
    return warnings;
  } catch {
    return [];
  }
}

/** The tasks the task builds on, directly or down the chain, whose work is not on the base branch yet. */
function unmergedBuiltOn(db: Db, task: Task): Task[] {
  const seen = new Set<number>([task.id]);
  const found: Task[] = [];
  const queue = [task.id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const link of db.linksOf(next)) {
      if (link.kind !== 'builds_on' || seen.has(link.on)) continue;
      seen.add(link.on);
      const dep = db.getTask(link.on);
      if (!dep) continue;
      if (linkState(link, targetOf(db, link.on)).kind === 'met') continue;
      found.push(dep);
      queue.push(dep.id);
    }
  }
  return found;
}
