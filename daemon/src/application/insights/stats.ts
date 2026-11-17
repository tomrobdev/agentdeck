// The pilot scorecard measures per repo, read from the database.
import type { App } from '#application/ports/app.ts';
import type { RepoId } from '#domain/shared/index.ts';
import { type Scorecard, buildScorecard } from '#domain/insights/index.ts';
import { type Measures, type StatsReport, measure, measureByRepo, measureByWeek } from '#domain/insights/index.ts';
import { type FailureReport, failureReport } from '#domain/insights/index.ts';
import { type ModelMeasures, measureByModel } from '#domain/insights/index.ts';
import { ActionError } from '#application/shared/input.ts';

export interface PilotReport extends StatsReport {
  scorecard: Scorecard;
  weeks: { week: string; measures: Measures }[];
  models: ModelMeasures[];
  failures: FailureReport;
}

export function pilotStats(app: App, opts: { repo?: string; since?: string; by?: 'week' | 'model' } = {}): PilotReport {
  const only = opts.repo === undefined ? undefined : app.findRepo(opts.repo);
  if (opts.repo !== undefined && !only) throw new ActionError(`no repo "${opts.repo}"`, undefined, 'not_found');
  const all = app.statRuns(only?.id);
  const rows = all.filter((r) => opts.since === undefined || r.started_at >= opts.since);
  const repoName = (id: RepoId) => app.getRepo(id)?.name ?? `repo${id}`;
  const repos = [...measureByRepo(rows)]
    .map(([id, measures]) => ({ repo: repoName(id), measures }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
  if (only && !repos.length) repos.push({ repo: only.name, measures: measure([]) });
  const tasks = app.scorecardTasks(only?.id);
  const events = app.scorecardEvents(only?.id);
  const scorecard = buildScorecard({
    tasks,
    events,
    samples: app.usageSamples('seven_day'),
    review_runs: app.scorecardReviewRuns(only?.id),
    run_reviews: app.scorecardRunReviews(only?.id),
    repoName,
    since: opts.since,
    by: opts.by === 'week' ? 'week' : undefined,
  });
  return {
    repos,
    total: measure(rows),
    scorecard,
    weeks: opts.by === 'week' ? measureByWeek(rows) : [],
    models: opts.by === 'model' ? measureByModel({ runs: all, tasks, events, since: opts.since }) : [],
    failures: failureReport({ runs: all, tasks, repoName, since: opts.since }),
  };
}
