// Insights' repository: the reads behind the stats and the scorecard.
import type { RepoId } from '../../../domain/shared/index.ts';
import type { ScorecardEvent, ScorecardReviewRun, ScorecardRunReview, ScorecardTaskRow, StatRun } from '../../../domain/insights/index.ts';

export interface StatsRepository {
  statRuns(repo_id?: RepoId): StatRun[];
  scorecardTasks(repo_id?: RepoId): ScorecardTaskRow[];
  scorecardEvents(repo_id?: RepoId): ScorecardEvent[];
  scorecardReviewRuns(repo_id?: RepoId): ScorecardReviewRun[];
  scorecardRunReviews(repo_id?: RepoId): ScorecardRunReview[];
}
