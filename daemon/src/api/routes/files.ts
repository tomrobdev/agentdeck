// Reads of the task's branch from git objects. ref is head or base, paths are repo-relative.
import * as actions from '../../application/actions.ts';
import type * as C from '../contract.ts';
import { type ApiContext, type Route, route, taskIdParam } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route<C.Changes>('GET', /^\/api\/tasks\/(\d+)\/changes$/, ({ params: [id] }) => actions.taskChanges(db, taskIdParam(id))),
    route<C.FilePatch>('GET', /^\/api\/tasks\/(\d+)\/diff$/, ({ params: [id], query }) =>
      actions.taskDiff(db, taskIdParam(id), query.get('path')),
    ),
    route<C.TreeListing>('GET', /^\/api\/tasks\/(\d+)\/tree$/, ({ params: [id], query }) =>
      actions.taskTree(db, taskIdParam(id), query.get('ref'), query.get('path')),
    ),
    route<C.FileContent>('GET', /^\/api\/tasks\/(\d+)\/file$/, ({ params: [id], query }) =>
      actions.taskFile(db, taskIdParam(id), query.get('ref'), query.get('path')),
    ),
  ];
}
