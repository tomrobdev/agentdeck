// The pilot scorecard measures per repo, read from the database.
import type { Db } from '../../db/index.ts';
import type { RepoId } from '../../domain/shared/id.ts';
import { type Scorecard, buildScorecard } from '../../domain/insights/scorecard.ts';
import { type Measures, type StatsReport, measure, measureByRepo, measureByWeek } from '../../domain/insights/stats.ts';
import { ActionError } from '../shared/input.ts';

/** The first-run measures and the rest of the scorecard (interventions, times, quota, PR checks). */
export interface PilotReport extends StatsReport {
  scorecard: Scorecard;
  /** The first-run measures per week, oldest first; empty unless `by` is week. */
  weeks: { week: string; measures: Measures }[];
}

/**
 * The measures of each repo with work runs and of all of them; with `repo` (name or id), only that repo. With `since`
 * (a sqlite stamp) only what began then; with `by` the scorecard also has a row per week.
 */
export function pilotStats(db: Db, opts: { repo?: string; since?: string; by?: 'week' } = {}): PilotReport {
  const only = opts.repo === undefined ? undefined : db.findRepo(opts.repo);
  if (opts.repo !== undefined && !only) throw new ActionError(`no repo "${opts.repo}"`);
  const rows = db.statRuns(only?.id).filter((r) => opts.since === undefined || r.started_at >= opts.since);
  const repoName = (id: RepoId) => db.getRepo(id)?.name ?? `repo${id}`;
  const repos = [...measureByRepo(rows)]
    .map(([id, measures]) => ({ repo: repoName(id), measures }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
  if (only && !repos.length) repos.push({ repo: only.name, measures: measure([]) });
  const scorecard = buildScorecard({
    tasks: db.scorecardTasks(only?.id),
    events: db.scorecardEvents(only?.id),
    samples: db.usageSamples('seven_day'),
    repoName,
    since: opts.since,
    by: opts.by,
  });
  return { repos, total: measure(rows), scorecard, weeks: opts.by === 'week' ? measureByWeek(rows) : [] };
}
