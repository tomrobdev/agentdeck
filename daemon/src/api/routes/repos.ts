// Repos: register, configure, check, pause, archive and delete.
import * as actions from '../../application/actions.ts';
import type * as C from '../contract.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  return [
    route<C.Repo[]>('GET', /^\/api\/repos$/, ({ query }) => db.listRepos({ archived: query.get('archived') === '1' })),
    route<C.Repo>('POST', /^\/api\/repos$/, ({ body }) => actions.addRepo(db, body as Parameters<typeof actions.addRepo>[1])),
    route<C.RepoDetail>('GET', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.repoDetail(db, Number(id))),
    route<C.RepoDetail>('POST', /^\/api\/repos\/(\d+)$/, ({ params: [id], body }) => actions.updateRepo(db, Number(id), body)),
    route<C.ProposalResult>('POST', /^\/api\/repos\/(\d+)\/propose$/, ({ params: [id] }) =>
      scheduler.track(actions.proposeNow(db, Number(id)), 'propose'),
    ),
    route<C.DoctorReport>('POST', /^\/api\/repos\/(\d+)\/doctor$/, ({ params: [id] }) => actions.doctorRepo(db, Number(id))),
    route<C.Repo>('POST', /^\/api\/repos\/(\d+)\/resume$/, ({ params: [id] }) => actions.resumeRepo(db, Number(id))),
    route<C.Repo>('POST', /^\/api\/repos\/(\d+)\/archive$/, ({ params: [id] }) => actions.archiveRepo(db, Number(id))),
    route<C.Repo>('POST', /^\/api\/repos\/(\d+)\/unarchive$/, ({ params: [id] }) => actions.unarchiveRepo(db, Number(id))),
    route<C.RepoDeletion>('GET', /^\/api\/repos\/(\d+)\/deletion$/, ({ params: [id] }) => actions.repoDeletionPreview(db, Number(id))),
    route<C.RepoDeleted>('DELETE', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.deleteRepo(db, Number(id))),
  ];
}
