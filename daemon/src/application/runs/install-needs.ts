// Install the packages a blocked task asked for, on a person's request.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { INSTALL_NOTE, LOCKFILES, canInstallWith, depsRequest, depsRequestError, installArgs } from '../../domain/work/index.ts';
import { errorMessage, lastLine } from '../../domain/shared/index.ts';
import { ActionError, refuse, requireTask, requireTaskRepo } from '../shared/input.ts';
import { refuseWhileSyncing } from '../work/checkout-locks.ts';
import { retryTask } from '../landing/person-events.ts';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Install the packages a blocked task asked for (NEEDS deps) on its branch, then retry it. Only a person's request
 * gets here (the API and the CLI); the worker and scheduler never call it. The package manager runs in the task's
 * worktree through the daemon, outside the worker's sandbox. On failure the task stays blocked.
 */
export async function installNeeds(app: App, id: TaskId): Promise<{ packages: string[]; dev: boolean }> {
  const task = requireTask(app, id);
  if (task.status !== 'blocked') throw new ActionError(`#${id} is ${task.status}, not blocked`);
  const { needs } = task;
  if (needs?.kind !== 'deps') throw new ActionError(`#${id} has not asked for packages`);
  const repo = requireTaskRepo(app, task);
  const toolchain = repo.toolchain ?? '';
  if (!canInstallWith(toolchain))
    throw new ActionError(
      `${repo.name} uses ${toolchain || 'no detected toolchain'}: install ${needs.items.join(' ')} on the branch yourself, then retry`,
    );
  refuse(depsRequestError(needs.items));
  const { packages, dev } = depsRequest(needs.items);
  const worktree = task.checkout?.worktree;
  if (!worktree || !existsSync(worktree)) throw new ActionError(`#${id} has no worktree to install into`);
  refuseWhileSyncing(app, id);

  const args = installArgs(toolchain, packages, dev);
  const result = await app.workspace.runCommand([toolchain, ...args], worktree, INSTALL_TIMEOUT_MS);
  if (!result.passed) {
    throw new ActionError(`${toolchain} ${args[0]} failed: ${lastLine(result.output)}`);
  }
  const files = ['package.json', LOCKFILES[toolchain]].filter((f) => existsSync(join(worktree, f)));
  try {
    await app.workspace.commit(worktree, `agentdeck: add ${packages.join(' ')} for task #${id}`, files);
  } catch (err) {
    throw new ActionError(`installed, but could not commit: ${lastLine(errorMessage(err))}`);
  }
  // The install took a while: a cancel or mark-done meanwhile stays.
  const now = app.getTask(id)?.status;
  if (now !== 'blocked')
    throw new ActionError(`installed ${packages.join(' ')}, but #${id} is now ${now ?? 'gone'}, so it was not retried`);
  retryTask(app, id, { note: `${INSTALL_NOTE} ${packages.join(' ')}${dev ? ' (dev)' : ''} on the branch at the person's request.` }, [
    'blocked',
  ]);
  return { packages, dev };
}
