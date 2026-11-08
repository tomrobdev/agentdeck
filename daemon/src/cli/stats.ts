// `agentdeck stats`: the pilot scorecard measures per repo, and per week or per model.
import * as actions from '../application/actions.ts';
import { failuresTable, modelsTable, parseSince, scorecardText } from '../domain/insights/index.ts';
import { statsTable } from '../domain/insights/index.ts';
import type { Command } from './context.ts';
import { die } from './format.ts';

export const statsCommands: Record<string, Command> = {
  stats: ({ db, flags }) => {
    const since = flags.since === undefined ? undefined : (parseSince(flags.since) ?? die('--since takes a date, like 2026-10-18'));
    if (flags.by !== undefined && flags.by !== 'week' && flags.by !== 'model') die('--by takes week or model');
    const by = flags.by as 'week' | 'model' | undefined;
    const report = actions.pilotStats(db, { repo: flags.repo, since, by });
    if (flags.json) return void console.log(JSON.stringify(report, null, 2));
    if (flags.failures) return void console.log(failuresTable(report.failures));
    const parts = [statsTable(report), ...(by === 'model' ? [modelsTable(report.models)] : []), scorecardText(report.scorecard)];
    console.log(parts.join('\n\n'));
  },
};
