// Repos: register, configure, check, pause, archive and delete.
import * as actions from '../../application/actions.ts';
import type * as C from '../contract.ts';
import { type ApiContext, type Route, repoIdParam, route } from '../http.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  return [
    route<C.Repo[]>('GET', /^\/api\/repos$/, ({ query }) =>
      actions.listRepos(db, { archived: query.get('archived') === '1' }).map(actions.repoView),
    ),
    route<C.Repo>('POST', /^\/api\/repos$/, async ({ body }) =>
      actions.repoView(await actions.addRepo(db, body as Parameters<typeof actions.addRepo>[1])),
    ),
    route<C.RepoDetail>('GET', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.repoDetail(db, repoIdParam(id))),
    route<C.RepoDetail>('POST', /^\/api\/repos\/(\d+)$/, ({ params: [id], body }) => actions.updateRepo(db, repoIdParam(id), body)),
    route<C.ProposalResult>('POST', /^\/api\/repos\/(\d+)\/propose$/, ({ params: [id] }) =>
      scheduler.track(actions.proposeNow(db, repoIdParam(id)), 'propose'),
    ),
    route<C.DoctorReport>('POST', /^\/api\/repos\/(\d+)\/doctor$/, ({ params: [id] }) => actions.doctorRepo(db, repoIdParam(id))),
    route<C.Repo>('POST', /^\/api\/repos\/(\d+)\/resume$/, ({ params: [id] }) => actions.repoView(actions.resumeRepo(db, repoIdParam(id)))),
    route<C.Repo>('POST', /^\/api\/repos\/(\d+)\/archive$/, ({ params: [id] }) =>
      actions.repoView(actions.archiveRepo(db, repoIdParam(id))),
    ),
    route<C.Repo>('POST', /^\/api\/repos\/(\d+)\/unarchive$/, ({ params: [id] }) =>
      actions.repoView(actions.unarchiveRepo(db, repoIdParam(id))),
    ),
    route<C.RepoDeletion>('GET', /^\/api\/repos\/(\d+)\/deletion$/, ({ params: [id] }) => actions.repoDeletionPreview(db, repoIdParam(id))),
    route<C.RepoDeleted>('DELETE', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.deleteRepo(db, repoIdParam(id))),
  ];
}
