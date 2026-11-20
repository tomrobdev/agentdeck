// The help lines of the stats command.
export const INSIGHTS_HELP = `  agentdeck stats [--repo r] [--since <date>] [--by week|model] [--failures] [--json]  the pilot scorecard measures per repo: tasks done on
                                  the first run (with a Wilson 95% interval), permission denials per run, cost and minutes per
                                  done task, then interventions, median minutes queued, running and in review, PRs green on CI
                                  when opened and quota spent (points of the 7-day window); --by week adds a row per week,
                                  --by model a row per model the work runs ran on (runs from before models were recorded: unknown);
                                  --failures instead prints what failures are made of per week and repo: failing checks by step
                                  (when the PR opened and when it merged) and failed or blocked runs by how they ended, with how
                                  many a retry then fixed (older rows count as unknown)`;
