// Repos: register, configure, check, pause, archive and delete.
import * as actions from '#application/actions.ts';
import type { DoctorReport, ProposalResult, Repo, RepoDeleted, RepoDeletion, RepoDetail } from '#api/contract/repos.ts';
import { type ApiContext, type Route, repoIdParam, route } from '#api/http.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  return [
    route<Repo[]>('GET', /^\/api\/repos$/, ({ query }) =>
      actions.listRepos(db, { archived: query.get('archived') === '1' }).map(actions.repoView),
    ),
    route<Repo>('POST', /^\/api\/repos$/, async ({ body }) =>
      actions.repoView(await actions.addRepo(db, body as Parameters<typeof actions.addRepo>[1])),
    ),
    route<RepoDetail>('GET', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.repoDetail(db, repoIdParam(id))),
    route<RepoDetail>('POST', /^\/api\/repos\/(\d+)$/, ({ params: [id], body }) => actions.updateRepo(db, repoIdParam(id), body)),
    route<ProposalResult>('POST', /^\/api\/repos\/(\d+)\/propose$/, ({ params: [id] }) =>
      scheduler.track(actions.proposeNow(db, repoIdParam(id)), 'propose'),
    ),
    route<DoctorReport>('POST', /^\/api\/repos\/(\d+)\/doctor$/, ({ params: [id] }) => actions.doctorRepo(db, repoIdParam(id))),
    route<Repo>('POST', /^\/api\/repos\/(\d+)\/resume$/, ({ params: [id] }) => actions.repoView(actions.resumeRepo(db, repoIdParam(id)))),
    route<Repo>('POST', /^\/api\/repos\/(\d+)\/drain$/, ({ params: [id] }) => actions.repoView(actions.drainRepo(db, repoIdParam(id)))),
    route<Repo>('POST', /^\/api\/repos\/(\d+)\/archive$/, ({ params: [id] }) => actions.repoView(actions.archiveRepo(db, repoIdParam(id)))),
    route<Repo>('POST', /^\/api\/repos\/(\d+)\/unarchive$/, ({ params: [id] }) =>
      actions.repoView(actions.unarchiveRepo(db, repoIdParam(id))),
    ),
    route<RepoDeletion>('GET', /^\/api\/repos\/(\d+)\/deletion$/, ({ params: [id] }) => actions.repoDeletionPreview(db, repoIdParam(id))),
    route<RepoDeleted>('DELETE', /^\/api\/repos\/(\d+)$/, ({ params: [id] }) => actions.deleteRepo(db, repoIdParam(id))),
  ];
}
