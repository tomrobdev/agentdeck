// The live state of a repo's queue for an agent's session (`agentdeck context`, run by Claude Code's hooks).
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { WORKTREE_DIR } from '#src/config.ts';
import type { App } from '#application/ports/app.ts';
import type { Repo } from '#domain/repos/index.ts';
import { type DigestTask, digest } from '#domain/operations/index.ts';
import { status } from '#application/operations/settings.ts';
import { repoReviewDue } from '#application/operations/review-due.ts';

export interface LiveContext {
  lines: string[];
  cursor: number;
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + sep);

export function repoForPath(app: App, dir: string): Repo | undefined {
  const here = real(dir);
  let best: { repo: Repo; depth: number } | undefined;
  for (const repo of app.listRepos()) {
    for (const root of [real(repo.path), join(real(WORKTREE_DIR), repo.name)]) {
      if (within(here, root) && (!best || root.length > best.depth)) best = { repo, depth: root.length };
    }
  }
  return best?.repo;
}

export async function digestContext(
  app: App,
  opts: { repo: Repo; after: number | null; full: boolean; open: DigestTask[] },
): Promise<LiveContext> {
  const cursor = app.lastEventId();
  const after = opts.after !== null && opts.after > cursor ? null : opts.after;
  const events = after === null ? [] : app.eventsAfter(after, cursor, opts.repo.id);
  const st = status(app);
  const [head, due] = await Promise.all([app.workspace.head(opts.repo.path), repoReviewDue(app, opts.repo)]);
  const lines = digest({
    header: {
      repo: opts.repo.name,
      paused: st.paused,
      repo_paused: opts.repo.paused_reason,
      running: st.running,
      max_concurrent: st.max_concurrent,
      governor: st.governor,
      rate_limited_until: st.rate_limited_until && st.rate_limited_until * 1000 > Date.now() ? st.rate_limited_until : null,
      head: head && { branch: head.branch, commit: head.short, subject: head.subject },
      review_due: due?.line ?? null,
    },
    events,
    open: opts.open,
    full: opts.full || after === null,
  });
  return { lines, cursor };
}
