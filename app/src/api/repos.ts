// Repos: registered repos, their settings, health and archiving, and asking the planner for proposals.
import { queryOptions } from '@tanstack/vue-query';
import { del, get, post } from '#api/http.ts';
import type { DoctorReport, NewRepo, ProposalResult, Repo, RepoDeleted, RepoDeletion, RepoDetail, RepoPatch } from '#api/types.ts';

export const reposApi = {
  repos: () => get<Repo[]>('/api/repos'),
  archivedRepos: () => get<Repo[]>('/api/repos?archived=1'),
  addRepo: (r: NewRepo) => post<Repo>('/api/repos', r),
  repo: (id: number) => get<RepoDetail>(`/api/repos/${id}`),
  updateRepo: (id: number, patch: RepoPatch) => post<RepoDetail>(`/api/repos/${id}`, patch),
  propose: (id: number) => post<ProposalResult>(`/api/repos/${id}/propose`),
  doctor: (id: number) => post<DoctorReport>(`/api/repos/${id}/doctor`),
  resumeRepo: (id: number) => post<Repo>(`/api/repos/${id}/resume`),
  archiveRepo: (id: number) => post<Repo>(`/api/repos/${id}/archive`),
  unarchiveRepo: (id: number) => post<Repo>(`/api/repos/${id}/unarchive`),
  repoDeletion: (id: number) => get<RepoDeletion>(`/api/repos/${id}/deletion`),
  deleteRepo: (id: number) => del<RepoDeleted>(`/api/repos/${id}`),
};

export const reposQuery = () => queryOptions({ queryKey: ['repos'] as const, queryFn: reposApi.repos });
export const archivedReposQuery = () => queryOptions({ queryKey: ['repos', 'archived'] as const, queryFn: reposApi.archivedRepos });
export const repoQuery = (id: number) => queryOptions({ queryKey: ['repo', id] as const, queryFn: () => reposApi.repo(id) });
export const repoDeletionQuery = (id: number) =>
  queryOptions({ queryKey: ['repo', id, 'deletion'] as const, queryFn: () => reposApi.repoDeletion(id) });
