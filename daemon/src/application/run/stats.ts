// The pilot scorecard measures per repo, read from the database.
import type { Db } from '../../db/index.ts';
import { type StatsReport, measure, measureByRepo } from '../../domain/run/stats.ts';
import { ActionError } from '../input.ts';

/** The measures of each repo with work runs and of all of them; with `repo` (name or id), only that repo. */
export function pilotStats(db: Db, opts: { repo?: string } = {}): StatsReport {
  const only = opts.repo === undefined ? undefined : db.findRepo(opts.repo);
  if (opts.repo !== undefined && !only) throw new ActionError(`no repo "${opts.repo}"`);
  const rows = db.statRuns(only?.id);
  const repos = [...measureByRepo(rows)]
    .map(([id, measures]) => ({ repo: db.getRepo(id)?.name ?? `repo${id}`, measures }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
  if (only && !repos.length) repos.push({ repo: only.name, measures: measure([]) });
  return { repos, total: measure(rows) };
}
