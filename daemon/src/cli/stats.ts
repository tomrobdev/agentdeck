// `agentdeck stats`: the pilot scorecard measures per repo.
import * as actions from '../application/actions.ts';
import { parseSince, scorecardText } from '../domain/insights/scorecard.ts';
import { statsTable } from '../domain/insights/stats.ts';
import type { Command } from './context.ts';
import { die } from './format.ts';

export const statsCommands: Record<string, Command> = {
  stats: ({ db, flags }) => {
    const since = flags.since === undefined ? undefined : (parseSince(flags.since) ?? die('--since takes a date, like 2026-10-18'));
    if (flags.by !== undefined && flags.by !== 'week') die('--by takes week');
    const report = actions.pilotStats(db, { repo: flags.repo, since, by: flags.by });
    console.log(flags.json ? JSON.stringify(report, null, 2) : `${statsTable(report)}\n\n${scorecardText(report.scorecard)}`);
  },
};
