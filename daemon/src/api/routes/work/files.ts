// Reads of the task's branch from git objects.
import * as actions from '../../../application/actions.ts';
import type { Changes, FileContent, FilePatch, ProposalCheck, TreeListing } from '../../contract/files.ts';
import { type ApiContext, type Route, route, taskIdParam } from '../../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route<Changes>('GET', /^\/api\/tasks\/(\d+)\/changes$/, ({ params: [id], query }) =>
      actions.taskChanges(db, taskIdParam(id), query.get('since')),
    ),
    route<FilePatch>('GET', /^\/api\/tasks\/(\d+)\/diff$/, ({ params: [id], query }) =>
      actions.taskDiff(db, taskIdParam(id), query.get('path'), query.get('since')),
    ),
    route<TreeListing>('GET', /^\/api\/tasks\/(\d+)\/tree$/, ({ params: [id], query }) =>
      actions.taskTree(db, taskIdParam(id), query.get('ref'), query.get('path')),
    ),
    route<FileContent>('GET', /^\/api\/tasks\/(\d+)\/file$/, ({ params: [id], query }) =>
      actions.taskFile(db, taskIdParam(id), query.get('ref'), query.get('path')),
    ),
    route<ProposalCheck>('GET', /^\/api\/tasks\/(\d+)\/proposal-check$/, ({ params: [id] }) => actions.proposalCheck(db, taskIdParam(id))),
  ];
}
