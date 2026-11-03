// Repos: register, configure, check, pause, archive and delete.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  return [
    route('GET', /^\/api\/repos$/, ({ query }) => db.listRepos({ archived: query.get('archived') === '1' })),
    route('POST', /^\/api\/repos$/, ({ body }) => actions.addRepo(db, body as Parameters<typeof actions.addRepo>[1])),
    route('GET', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.repoDetail(db, Number(id))),
    route('POST', /^\/api\/repos\/(\d+)$/, ({ params: [id], body }) => actions.updateRepo(db, Number(id), body)),
    route('POST', /^\/api\/repos\/(\d+)\/propose$/, ({ params: [id] }) => scheduler.track(actions.proposeNow(db, Number(id)), 'propose')),
    route('POST', /^\/api\/repos\/(\d+)\/doctor$/, ({ params: [id] }) => actions.doctorRepo(db, Number(id))),
    route('POST', /^\/api\/repos\/(\d+)\/resume$/, ({ params: [id] }) => actions.resumeRepo(db, Number(id))),
    route('POST', /^\/api\/repos\/(\d+)\/archive$/, ({ params: [id] }) => actions.archiveRepo(db, Number(id))),
    route('POST', /^\/api\/repos\/(\d+)\/unarchive$/, ({ params: [id] }) => actions.unarchiveRepo(db, Number(id))),
    route('GET', /^\/api\/repos\/(\d+)\/deletion$/, ({ params: [id] }) => actions.repoDeletionPreview(db, Number(id))),
    route('DELETE', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.deleteRepo(db, Number(id))),
  ];
}
