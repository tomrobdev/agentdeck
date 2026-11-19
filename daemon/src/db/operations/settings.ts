// Key-value settings: pause flag, budget, concurrency, notification, planner and model options.
import { eq } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '#src/config.ts';
import { DEFAULT_REVIEW_DUE, NOTIFY_KINDS, type NotifyKind, type NotifySettings, type ReviewDue } from '#domain/operations/index.ts';
import type { RepoId } from '#domain/shared/index.ts';
import type { PlannerSettings } from '#domain/proposals/index.ts';
import { DEFAULT_REVIEW_MODEL, DEFAULT_SUPPORT_MODEL } from '#domain/runs/index.ts';
import {
  DEFAULT_MODEL,
  DEFAULT_PLAN_BRANCH_MAX_DAYS,
  DEFAULT_PLAN_BRANCH_MAX_LINES,
  DEFAULT_PLAN_BRANCH_SYNC_MINUTES,
} from '#domain/work/index.ts';
import type { Settings } from '#domain/operations/index.ts';
import { BUDGET_KEYS, type Budget, DEFAULT_BUDGET, type Draining } from '#domain/capacity/index.ts';
import type { Orm } from '#db/orm.ts';
import { atomically } from '#db/sql.ts';
import { settings } from '#db/tables.ts';

export const SETTING_DEFAULTS = {
  paused: '1',
  draining: '0',
  draining_repos: '[]',
  rate_limited_until: '0',
  pr_check_requested: '0',
  app_seen_at: '0',
  restart_pause_at: '0',
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
  plan_branch_sync_minutes: String(DEFAULT_PLAN_BRANCH_SYNC_MINUTES),
  plan_branch_max_days: String(DEFAULT_PLAN_BRANCH_MAX_DAYS),
  plan_branch_max_lines: String(DEFAULT_PLAN_BRANCH_MAX_LINES),
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
    setSetting: set,
    readSettings: (): Settings => ({
      max_concurrent: Number(get('max_concurrent')),
      budget: budget(),
      notify: notifySettings(),
      planner: plannerSettings(),
      ...modelSettings(),
      reload_on_change: get('reload_on_change') === '1',
      review_due: { days: Number(get('review_due_days')), lines: Number(get('review_due_lines')) },
      plan_branch_sync_minutes: Number(get('plan_branch_sync_minutes')),
      plan_branch_max_days: Number(get('plan_branch_max_days')),
      plan_branch_max_lines: Number(get('plan_branch_max_lines')),
    }),
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
        set('plan_branch_sync_minutes', String(s.plan_branch_sync_minutes));
        set('plan_branch_max_days', String(s.plan_branch_max_days));
        set('plan_branch_max_lines', String(s.plan_branch_max_lines));
      }),
    reviewsDue: (): ReviewDue[] => json<ReviewDue[]>('reviews_due', []),
    setReviewsDue: (dues: ReviewDue[]): void => set('reviews_due', JSON.stringify(dues)),
    reviewDueToldAt: (repo: RepoId): number | null => json<Record<string, number>>('review_due_told', {})[repo] ?? null,
    setReviewDueToldAt: (repo: RepoId, at: number): void =>
      atomically(db, () => set('review_due_told', JSON.stringify({ ...json<Record<string, number>>('review_due_told', {}), [repo]: at }))),
    isPaused: (): boolean => get('paused') === '1',
    setPaused: (paused: boolean): void => set('paused', paused ? '1' : '0'),
    draining: (): Draining => ({ daemon: get('draining') === '1', repos: json<RepoId[]>('draining_repos', []) }),
    setDraining: (d: Draining): void =>
      atomically(db, () => {
        set('draining', d.daemon ? '1' : '0');
        set('draining_repos', JSON.stringify([...new Set(d.repos)]));
      }),
    restartPauseAt: (): number | null => Number(get('restart_pause_at')) || null,
    setRestartPauseAt: (at: number | null): void => set('restart_pause_at', String(at ?? 0)),
    rateLimitedUntil: (): number | null => Number(get('rate_limited_until')) || null,
    setRateLimitedUntil: (until: number): void => set('rate_limited_until', String(until)),
    reloadOnChange: (): boolean => get('reload_on_change') === '1',
    prCheckRequested: (): number => Number(get('pr_check_requested')),
    requestPrCheck: (at = Date.now()): void => set('pr_check_requested', String(at)),
    appSeenAt: (): number | null => Number(get('app_seen_at')) || null,
    setAppSeenAt: (at: number): void => set('app_seen_at', String(at)),
    budget,
    maxConcurrent: (): number => Number(get('max_concurrent')),
    planBranchSyncMinutes: (): number => Number(get('plan_branch_sync_minutes')),
    notifySettings,
    plannerSettings,
    modelSettings,
  };
}
