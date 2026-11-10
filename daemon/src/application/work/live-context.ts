// The live state of a repo's queue for an agent's session (`agentdeck context`): the open tasks are Work's to read, the digest around them is Operations' (`operations/digest.ts`).
import type { App } from '../ports/app.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { OPEN_STATUSES, filterTasks, isReview, listable, stageOf } from '../../domain/work/index.ts';
import { type LiveContext, digestContext } from '../operations/digest.ts';
import { withViews } from './task-views.ts';

const OPEN_STATES = ['active', 'needs-you', 'proposed', 'review'];

export async function liveContext(app: App, opts: { repo: Repo; after: number | null; full: boolean }): Promise<LiveContext> {
  const maybeOpen = app
    .listTasks()
    .filter((t) => t.repo_id === opts.repo.id && ([...OPEN_STATUSES, 'blocked', 'failed'].includes(t.status) || isReview(stageOf(t))));
  const open = filterTasks(withViews(app, maybeOpen).map(listable), { states: OPEN_STATES, repo_id: opts.repo.id, sort: 'attention' });
  return digestContext(app, { ...opts, open });
}
