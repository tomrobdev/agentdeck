// `agentdeck stats`: the pilot scorecard measures per repo.
import * as actions from '../application/actions.ts';
import { statsTable } from '../domain/run/stats.ts';
import type { Command } from './context.ts';

export const statsCommands: Record<string, Command> = {
  stats: ({ db, flags }) => {
    const report = actions.pilotStats(db, { repo: flags.repo });
    console.log(flags.json ? JSON.stringify(report, null, 2) : statsTable(report));
  },
};
