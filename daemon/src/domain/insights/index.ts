// The insights context's interface: what other contexts and the layers above import.
export { measureByModel, modelsTable } from '#domain/insights/by-model.ts';
export type { ModelMeasures } from '#domain/insights/by-model.ts';
export { failureReport, failuresTable } from '#domain/insights/failures.ts';
export type { FailureReport } from '#domain/insights/failures.ts';
export { SCORECARD_TARGETS, buildScorecard, parseSince, scorecardText } from '#domain/insights/scorecard.ts';
export type { Scorecard, ScorecardEvent, ScorecardTaskRow } from '#domain/insights/scorecard.ts';
export type { MergeWaitMeasures } from '#domain/insights/merge-wait.ts';
export type { ScorecardReviewRun, ScorecardRunReview } from '#domain/insights/review-runs.ts';
export { measure, measureByRepo, measureByWeek, statsTable } from '#domain/insights/stats.ts';
export type { Measures, StatRun, StatsReport } from '#domain/insights/stats.ts';
