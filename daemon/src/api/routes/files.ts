// Reads of the task's branch from git objects. ref is head or base, paths are repo-relative.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route('GET', /^\/api\/tasks\/(\d+)\/changes$/, ({ params: [id] }) => actions.taskChanges(db, Number(id))),
    route('GET', /^\/api\/tasks\/(\d+)\/diff$/, ({ params: [id], query }) => actions.taskDiff(db, Number(id), query.get('path'))),
    route('GET', /^\/api\/tasks\/(\d+)\/tree$/, ({ params: [id], query }) =>
      actions.taskTree(db, Number(id), query.get('ref'), query.get('path')),
    ),
    route('GET', /^\/api\/tasks\/(\d+)\/file$/, ({ params: [id], query }) =>
      actions.taskFile(db, Number(id), query.get('ref'), query.get('path')),
    ),
  ];
}
