// Insights: the scorecard and what is counted over time.

/** A Wilson 95% interval. */
export interface Interval {
  low: number;
  high: number;
}

/** The first-run measures of a set of work runs (`agentdeck stats`). */
export interface RunMeasures {
  tasks: number;
  runs: number;
  first_runs: number;
  first_run_done: number;
  first_run_rate: number | null;
  first_run_interval: Interval | null;
  denials: number;
  denials_per_run: number | null;
  done_tasks: number;
  cost_per_done_task: number | null;
  minutes_per_done_task: number | null;
}

/** The scorecard's interventions, with how many were of each kind. */
export interface InterventionCount {
  total: number;
  tasks: number;
  by_kind: Record<string, number>;
}

/** The rest of the scorecard's measures: medians are in minutes, null when there is nothing to take them over. */
export interface ScorecardMeasures {
  interventions: InterventionCount;
  tasks: number;
  queued_minutes: number | null;
  running_minutes: number | null;
  review_minutes: number | null;
  pr_checks: { recorded: number; green: number; rate: number | null };
}

/** One cause of failures and how often it came up, such as "CI › Coverage floors" or "used its turns, tests failing". */
export interface FailureCause {
  cause: string;
  count: number;
}

/** What failures were made of in one week and repo (`agentdeck stats --failures`). */
export interface FailureWeek {
  week: string;
  repo: string;
  /** Failing checks by step on the head the PR first settled on, and on the head it merged on. */
  checks_opened: FailureCause[];
  checks_merged: FailureCause[];
  /** Failed or blocked work runs by how they ended; "unknown end" for runs from before it was kept. */
  runs: FailureCause[];
  runs_failed: number;
  /** Of those, the runs a later run of the task then finished. */
  runs_fixed: number;
}

/** The failures per week and repo, and the most frequent causes over all of them. */
export interface FailureReport {
  weeks: FailureWeek[];
  top: (FailureCause & { kind: 'check' | 'run'; where: 'opened' | 'merged' | 'run' })[];
}

/** GET /api/stats?repo=<name or id>&since=<date>&by=week|model: what `agentdeck stats --json` prints. */
export interface Stats {
  repos: { repo: string; measures: RunMeasures }[];
  total: RunMeasures;
  /** The first-run measures per week, oldest first; empty unless `by` is week. */
  weeks: { week: string; measures: RunMeasures }[];
  /**
   * The measures per model the work runs ran on, by name with "unknown" (runs from before models were recorded) last, and
   * the interventions counted against each; empty unless `by` is model. Missing from a daemon that predates it.
   */
  models?: { model: string; measures: RunMeasures; interventions: number }[];
  /** What failures are made of; missing from a daemon that predates it. */
  failures?: FailureReport;
  scorecard: {
    since: string | null;
    by: 'week' | null;
    repos: { repo: string; measures: ScorecardMeasures }[];
    total: ScorecardMeasures;
    /** Percentage points of the 7-day window spent. */
    quota_points: number;
    /** One per week with anything in it, oldest first; empty unless `by` is week. */
    weeks: { week: string; measures: ScorecardMeasures; quota_points: number }[];
  };
}
