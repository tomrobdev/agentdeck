// Operations' repositories: the settings, the notifications sent, and the change feed the dashboard watches.
import type { RepoId, TaskId } from '../../../domain/shared/index.ts';
import type { Budget } from '../../../domain/capacity/index.ts';
import type { Notification, NotifySettings, ReviewDue, Settings } from '../../../domain/operations/index.ts';
import type { PlannerSettings } from '../../../domain/proposals/index.ts';

export interface NotificationRepository {
  addNotification(kind: string, title: string, body: string, task_id: TaskId | null): void;
  recentNotifications(limit?: number): {
    id: number;
    kind: Notification['kind'];
    title: string;
    body: string;
    task_id: TaskId | null;
    created_at: string;
  }[];
}

export interface SettingsRepository {
  readSettings(): Settings;
  writeSettings(s: Settings): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  /** Unix seconds until which claude is rate limited, or null when it is not (or has lifted). */
  rateLimitedUntil(): number | null;
  setRateLimitedUntil(until: number): void;
  reloadOnChange(): boolean;
  prCheckRequested(): number;
  requestPrCheck(at?: number): void;
  appSeenAt(): number | null;
  setAppSeenAt(at: number): void;
  budget(): Budget;
  maxConcurrent(): number;
  notifySettings(): NotifySettings;
  plannerSettings(): PlannerSettings;
  /** The default_model, support_model and review_model settings. */
  modelSettings(): Pick<Settings, 'default_model' | 'support_model' | 'review_model'>;
  /** The repos due for an area review, as the daemon's last check found them, for the headline. */
  reviewsDue(): ReviewDue[];
  setReviewsDue(dues: ReviewDue[]): void;
  /** When a person was last told the repo is due for an area review (ms since the epoch); null when never. */
  reviewDueToldAt(repo: RepoId): number | null;
  setReviewDueToldAt(repo: RepoId, at: number): void;
}

export interface ChangeRepository {
  changeCounters(): { dataVersion: number; ownChanges: number };
}
