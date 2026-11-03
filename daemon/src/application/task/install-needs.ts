// Install the packages a blocked task asked for, on a person's request.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commitFiles } from '../../adapters/git.ts';
import { runProgram } from '../../adapters/shell.ts';
import type { Db } from '../../db/index.ts';
import { INSTALL_NOTE, LOCKFILES, canInstallWith, depsRequest, depsRequestError, installArgs, readNeeds } from '../../domain/task/needs.ts';
import { lastLine } from '../../domain/text.ts';
import { ActionError, refuse, requireTask, requireTaskRepo } from '../input.ts';
import { refuseWhileSyncing } from '../sync.ts';
import { retryTask } from './tasks.ts';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Install the packages a blocked task asked for (NEEDS deps) on its branch, then retry it. Only a person's request
 * gets here (the API and the CLI); the worker and scheduler never call it. The package manager runs in the task's
 * worktree through the daemon, outside the worker's sandbox. On failure the task stays blocked.
 */
export async function installNeeds(db: Db, id: number): Promise<{ packages: string[]; dev: boolean }> {
  const task = requireTask(db, id);
  if (task.status !== 'blocked') throw new ActionError(`#${id} is ${task.status}, not blocked`);
  const needs = readNeeds(task.needs);
  if (needs?.kind !== 'deps') throw new ActionError(`#${id} has not asked for packages`);
  const repo = requireTaskRepo(db, task);
  const toolchain = repo.toolchain ?? '';
  if (!canInstallWith(toolchain))
    throw new ActionError(
      `${repo.name} uses ${toolchain || 'no detected toolchain'}: install ${needs.items.join(' ')} on the branch yourself, then retry`,
    );
  refuse(depsRequestError(needs.items));
  const { packages, dev } = depsRequest(needs.items);
  if (!task.worktree || !existsSync(task.worktree)) throw new ActionError(`#${id} has no worktree to install into`);
  refuseWhileSyncing(db, id);

  const args = installArgs(toolchain, packages, dev);
  const result = await runProgram(toolchain, args, task.worktree, INSTALL_TIMEOUT_MS);
  if (!result.passed) {
    throw new ActionError(`${toolchain} ${args[0]} failed: ${lastLine(result.output)}`);
  }
  const files = ['package.json', LOCKFILES[toolchain]].filter((f) => existsSync(join(task.worktree!, f)));
  try {
    await commitFiles(task.worktree, files, `agentdeck: add ${packages.join(' ')} for task #${id}`);
  } catch (err) {
    throw new ActionError(`installed, but could not commit: ${lastLine((err as Error).message)}`);
  }
  // The install took a while: a cancel or mark-done meanwhile stays.
  const now = db.getTask(id)?.status;
  if (now !== 'blocked')
    throw new ActionError(`installed ${packages.join(' ')}, but #${id} is now ${now ?? 'gone'}, so it was not retried`);
  retryTask(db, id, `${INSTALL_NOTE} ${packages.join(' ')}${dev ? ' (dev)' : ''} on the branch at the person's request.`, ['blocked']);
  return { packages, dev };
}
