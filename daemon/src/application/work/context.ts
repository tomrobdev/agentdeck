// The live state of a repo's queue for an agent's session (`agentdeck context`, run by Claude Code's hooks).
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { headSummary } from '../../adapters/git.ts';
import { WORKTREE_DIR } from '../../config.ts';
import type { Repositories as Db } from '../ports/repositories.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { digest } from '../../domain/work/index.ts';
import { filterTasks, listable } from '../../domain/work/index.ts';
import { isReview, stageOf } from '../../domain/work/index.ts';
import { OPEN_STATUSES } from '../../domain/work/index.ts';
import { status } from '../operations/settings.ts';
import { withViews } from './task-views.ts';

/** What the session is shown, and the cursor to pass as `after` next time. */
export interface LiveContext {
  lines: string[];
  cursor: number;
}

/** Open means it is moving or someone has to act on it. */
const OPEN_STATES = ['active', 'needs-you', 'proposed', 'review'];

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + sep);

/** The registered repo a directory is in: its checkout, or one of its task worktrees. The deepest match wins. */
export function repoForPath(db: Db, dir: string): Repo | undefined {
  const here = real(dir);
  let best: { repo: Repo; depth: number } | undefined;
  for (const repo of db.listRepos()) {
    for (const root of [real(repo.path), join(real(WORKTREE_DIR), repo.name)]) {
      if (within(here, root) && (!best || root.length > best.depth)) best = { repo, depth: root.length };
    }
  }
  return best?.repo;
}

/**
 * The repo's queue: the header, what changed after event `after` (none when `after` is null), and the open tasks when
 * something changed or `full` is set. `cursor` is the newest event now, whatever repo it belongs to.
 */
export async function liveContext(db: Db, opts: { repo: Repo; after: number | null; full: boolean }): Promise<LiveContext> {
  const cursor = db.lastEventId();
  // A cursor above the newest event is from other ids (a repo deleted, a restored database): it is no cursor.
  const after = opts.after !== null && opts.after > cursor ? null : opts.after;
  const events = after === null ? [] : db.eventsAfter(after, cursor, opts.repo.id);
  const st = status(db);
  // Only this repo's tasks that can be open get views; the views are the costly part.
  const maybeOpen = db
    .listTasks()
    .filter((t) => t.repo_id === opts.repo.id && ([...OPEN_STATUSES, 'blocked', 'failed'].includes(t.status) || isReview(stageOf(t))));
  const open = filterTasks(withViews(db, maybeOpen).map(listable), { states: OPEN_STATES, repo_id: opts.repo.id, sort: 'attention' });
  const lines = digest({
    header: {
      repo: opts.repo.name,
      paused: st.paused,
      repo_paused: opts.repo.paused_reason,
      running: st.running,
      max_concurrent: st.max_concurrent,
      governor: st.governor,
      rate_limited_until: st.rate_limited_until && st.rate_limited_until * 1000 > Date.now() ? st.rate_limited_until : null,
      head: await headSummary(opts.repo.path),
    },
    events,
    open,
    full: opts.full || after === null,
  });
  return { lines, cursor };
}
