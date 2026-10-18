// Pausing a repo: its queued tasks stay queued but aren't claimed until someone fixes the cause.
import type { Db, Repo } from './db.ts';
import { notifyLater } from './notify.ts';

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
      kind: 'hold',
      title: `Paused ${repo.name}`,
      body: `${reason}. Fix it, then run \`agentdeck repo resume ${repo.name}\`.`,
    });
  }
  return true;
}

/** The first refused command of a run, on one line, for a pause reason. */
export function firstDenial(denials: { tool_name?: string; tool_input?: { command?: unknown } }[]): string {
  const d = denials[0];
  const command = typeof d?.tool_input?.command === 'string' ? d.tool_input.command : (d?.tool_name ?? 'unknown tool');
  return command.replace(/\s+/g, ' ').trim().slice(0, 200);
}
