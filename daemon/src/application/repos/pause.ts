// Pausing a repo: its queued tasks stay queued but aren't claimed until someone fixes the cause.
import type { App } from '../ports/app.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { notifyLater } from '../operations/notifications.ts';

export function pauseRepo(app: App, repo: Pick<Repo, 'id' | 'name'>, reason: string, opts: { replace?: boolean } = {}): boolean {
  const wasPaused = !!app.getRepo(repo.id)?.paused_reason;
  if (opts.replace) app.setRepoPaused(repo.id, reason);
  else if (!app.pauseRepo(repo.id, reason)) return false;
  if (!wasPaused) {
    notifyLater(app, {
      kind: 'paused',
      title: `Paused ${repo.name}`,
      body: `${reason}. Fix it, then run \`agentdeck repo resume ${repo.name}\`.`,
    });
  }
  return true;
}
