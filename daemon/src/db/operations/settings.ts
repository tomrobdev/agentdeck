// Key-value settings: pause flag, budget, concurrency, notification, planner and model options.
import { eq } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../../config.ts';
import { DEFAULT_REVIEW_DUE, NOTIFY_KINDS, type NotifyKind, type NotifySettings, type ReviewDue } from '../../domain/operations/index.ts';
import type { RepoId } from '../../domain/shared/index.ts';
import type { PlannerSettings } from '../../domain/proposals/index.ts';
import { DEFAULT_REVIEW_MODEL, DEFAULT_SUPPORT_MODEL } from '../../domain/runs/index.ts';
import { DEFAULT_MODEL } from '../../domain/work/index.ts';
import type { Settings } from '../../domain/operations/index.ts';
import { BUDGET_KEYS, type Budget, DEFAULT_BUDGET } from '../../domain/capacity/index.ts';
import type { Orm } from '../orm.ts';
import { atomically } from '../sql.ts';
import { settings } from '../tables.ts';

/** What each setting reads as until someone sets it. The daemon starts paused until someone resumes it. */
export const SETTING_DEFAULTS = {
  paused: '1',
  rate_limited_until: '0',
  pr_check_requested: '0',
  app_seen_at: '0',
  reload_on_change: '0',
  max_concurrent: String(DEFAULTS.maxConcurrent),
  notify_desktop: '1',
  notify_events: NOTIFY_KINDS.join(','),
  ntfy_topic: '',
  ntfy_server: 'https://ntfy.sh',
  planner_enabled: '1',
  planner_interval_hours: '3',
  planner_max_tasks: '3',
  planner_model: DEFAULT_MODEL,
  default_model: DEFAULT_MODEL,
  support_model: DEFAULT_SUPPORT_MODEL,
  review_model: DEFAULT_REVIEW_MODEL,
  review_due_days: String(DEFAULT_REVIEW_DUE.days),
  review_due_lines: String(DEFAULT_REVIEW_DUE.lines),
  reviews_due: '[]',
  review_due_told: '{}',
  ...Object.fromEntries(BUDGET_KEYS.map((k) => [k, String(DEFAULT_BUDGET[k])])),
} as Record<string, string>;

export function settingsStore(db: DatabaseSync, orm: Orm) {
  const get = (key: string): string =>
    orm.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value ?? SETTING_DEFAULTS[key] ?? '';
  const set = (key: string, value: string): void => {
    orm.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  };
  /** A setting the daemon keeps as JSON; `fallback` when it does not parse. */
  const json = <T>(key: string, fallback: T): T => {
    try {
      return (JSON.parse(get(key)) as T) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const budget = (): Budget => {
    const out = { ...DEFAULT_BUDGET };
    for (const k of BUDGET_KEYS) out[k] = Number(get(k));
    return out;
  };
  const notifySettings = (): NotifySettings => ({
    desktop: get('notify_desktop') === '1',
    events: get('notify_events').split(',').filter(Boolean) as NotifyKind[],
    ntfy_topic: get('ntfy_topic'),
    ntfy_server: get('ntfy_server'),
  });
  const plannerSettings = (): PlannerSettings => ({
    enabled: get('planner_enabled') === '1',
    interval_hours: Number(get('planner_interval_hours')),
    max_tasks: Number(get('planner_max_tasks')),
    model: get('planner_model'),
  });
  const modelSettings = (): Pick<Settings, 'default_model' | 'support_model' | 'review_model'> => ({
    default_model: get('default_model'),
    support_model: get('support_model'),
    review_model: get('review_model'),
  });
  return {
    /** Raw write by key, for flags the daemon keeps for itself. The person's settings go through writeSettings. */
    setSetting: set,
    /** The settings a person can change, as one value. */
    readSettings: (): Settings => ({
      max_concurrent: Number(get('max_concurrent')),
      budget: budget(),
      notify: notifySettings(),
      planner: plannerSettings(),
      ...modelSettings(),
      reload_on_change: get('reload_on_change') === '1',
      review_due: { days: Number(get('review_due_days')), lines: Number(get('review_due_lines')) },
    }),
    /** Store all of `s` in one transaction. */
    writeSettings: (s: Settings): void =>
      atomically(db, () => {
        set('max_concurrent', String(s.max_concurrent));
        for (const k of BUDGET_KEYS) set(k, String(s.budget[k]));
        set('notify_desktop', s.notify.desktop ? '1' : '0');
        set('notify_events', s.notify.events.join(','));
        set('ntfy_topic', s.notify.ntfy_topic);
        set('ntfy_server', s.notify.ntfy_server);
        set('planner_enabled', s.planner.enabled ? '1' : '0');
        set('planner_interval_hours', String(s.planner.interval_hours));
        set('planner_max_tasks', String(s.planner.max_tasks));
        set('planner_model', s.planner.model);
        set('default_model', s.default_model);
        set('support_model', s.support_model);
        set('review_model', s.review_model);
        set('reload_on_change', s.reload_on_change ? '1' : '0');
        set('review_due_days', String(s.review_due.days));
        set('review_due_lines', String(s.review_due.lines));
      }),
    /** The repos due for an area review, as the daemon's last check found them. */
    reviewsDue: (): ReviewDue[] => json<ReviewDue[]>('reviews_due', []),
    setReviewsDue: (dues: ReviewDue[]): void => set('reviews_due', JSON.stringify(dues)),
    /** When a person was last told the repo is due for an area review, in ms since the epoch; null when never. */
    reviewDueToldAt: (repo: RepoId): number | null => json<Record<string, number>>('review_due_told', {})[repo] ?? null,
    setReviewDueToldAt: (repo: RepoId, at: number): void =>
      atomically(db, () => set('review_due_told', JSON.stringify({ ...json<Record<string, number>>('review_due_told', {}), [repo]: at }))),
    isPaused: (): boolean => get('paused') === '1',
    setPaused: (paused: boolean): void => set('paused', paused ? '1' : '0'),
    /** Unix seconds until which claude is rate limited, or null when it is not (or has lifted). */
    rateLimitedUntil: (): number | null => Number(get('rate_limited_until')) || null,
    setRateLimitedUntil: (until: number): void => set('rate_limited_until', String(until)),
    reloadOnChange: (): boolean => get('reload_on_change') === '1',
    /** When a PR re-read was last asked for, in ms since the epoch. */
    prCheckRequested: (): number => Number(get('pr_check_requested')),
    requestPrCheck: (at = Date.now()): void => set('pr_check_requested', String(at)),
    /** When the desktop app last said it is running, in ms since the epoch; null when it never did. */
    appSeenAt: (): number | null => Number(get('app_seen_at')) || null,
    setAppSeenAt: (at: number): void => set('app_seen_at', String(at)),
    budget,
    maxConcurrent: (): number => Number(get('max_concurrent')),
    notifySettings,
    plannerSettings,
    modelSettings,
  };
}
