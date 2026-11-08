// Pausing a repo: its queued tasks stay queued but aren't claimed until someone fixes the cause.
import type { Db } from '../../db/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { notifyLater } from '../operations/notifications.ts';

/**
 * Pause a repo and tell a human. A repo that is already paused keeps its first reason (and doesn't
 * notify again) unless `replace` is set. Returns whether the reason was written.
 */
export function pauseRepo(db: Db, repo: Pick<Repo, 'id' | 'name'>, reason: string, opts: { replace?: boolean } = {}): boolean {
  const wasPaused = !!db.getRepo(repo.id)?.paused_reason;
  if (opts.replace) db.setRepoPaused(repo.id, reason);
  else if (!db.pauseRepo(repo.id, reason)) return false;
  if (!wasPaused) {
    notifyLater(db, {
      kind: 'paused',
      title: `Paused ${repo.name}`,
      body: `${reason}. Fix it, then run \`agentdeck repo resume ${repo.name}\`.`,
    });
  }
  return true;
}
