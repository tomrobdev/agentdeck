// Warn when a task's prompt names a repo path that won't be there when the task runs.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { linkState } from '../../domain/work/index.ts';
import { matchPath, pathsNamedIn } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { targetOf } from './dependencies.ts';
import { requireTask, requireTaskRepo } from '../shared/input.ts';

/**
 * Warnings (never errors) for each path the task's prompt names that is not in the commit the worker starts from
 * (origin's base when the repo has one) and that no task it builds on adds: a worker told to follow a file that isn't
 * there blocks. A path found only under a subfolder gets its own note, to be written in full. A task it builds on that is not merged yet
 * counts through its branch; with no branch yet, the path "may come from it". Checks the saved task, so call it after
 * addTask or editTask. Git trouble (no base commit, an unreadable repo) means no warnings, not a failure.
 */
export async function promptWarnings(app: App, id: TaskId): Promise<string[]> {
  const task = requireTask(app, id);
  const paths = pathsNamedIn(task.prompt);
  if (!paths.length) return [];
  try {
    const repo = requireTaskRepo(app, task);
    // The commit a worker starts from (see startPoint), not the local base: a plan committed but not pushed isn't there.
    const start = await app.workspace.filesAt(repo.path, { base: repo.base_branch });
    if (!start) return [];
    const { ref, files: baseFiles } = start;
    const sources = unmergedBuiltOn(app, task);
    const branchless = sources.filter((s) => !s.checkout?.branch).map((s) => `#${s.id}`);
    const branchFiles = (
      await Promise.all(
        sources.flatMap(async (s) => {
          const dep = app.getRepo(s.repo_id);
          const at = dep && s.checkout?.branch ? await app.workspace.filesAt(dep.path, { branch: s.checkout.branch }) : null;
          return at ? [at.files] : [];
        }),
      )
    ).flat();
    const warnings: string[] = [];
    for (const named of paths) {
      const onBase = matchPath(named, baseFiles);
      if (onBase.kind === 'exact') continue;
      if (branchFiles.some((files) => matchPath(named, files).kind === 'exact')) continue;
      if (onBase.kind === 'under') {
        warnings.push(`the prompt names ${named}: found as ${onBase.as}; write it in full`);
        continue;
      }
      const missing = `the prompt names ${named}, which isn't on ${ref}`;
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
function unmergedBuiltOn(app: App, task: Task): Task[] {
  const seen = new Set<TaskId>([task.id]);
  const found: Task[] = [];
  const queue = [task.id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const link of app.linksOf(next)) {
      if (link.kind !== 'builds_on' || seen.has(link.on)) continue;
      seen.add(link.on);
      const dep = app.getTask(link.on);
      if (!dep) continue;
      if (linkState(link, targetOf(app, link.on)).kind === 'met') continue;
      found.push(dep);
      queue.push(dep.id);
    }
  }
  return found;
}
