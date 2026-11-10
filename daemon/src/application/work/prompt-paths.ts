// Warn when a task's prompt names a repo path that won't be there when the task runs.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { linkState } from '../../domain/work/index.ts';
import { matchPath, pathsNamedIn } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { targetOf } from './dependencies.ts';
import { requireTask, requireTaskRepo } from '../shared/input.ts';

export async function promptWarnings(app: App, id: TaskId): Promise<string[]> {
  const task = requireTask(app, id);
  const paths = pathsNamedIn(task.prompt);
  if (!paths.length) return [];
  try {
    const repo = requireTaskRepo(app, task);
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
