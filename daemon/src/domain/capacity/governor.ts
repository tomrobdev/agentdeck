// Decides whether the scheduler may start new work, from the utilization Claude reports in rate_limit_event (five_hour and seven_day windows, 0..1).

import { wholeNumberError } from '../shared/index.ts';

export interface Budget {
  five_hour_max: number;
  five_hour_soft: number;
  weekly_max: number;
  pace_slack: number;
}

export const DEFAULT_BUDGET: Budget = {
  five_hour_max: 0.85,
  five_hour_soft: 0.6,
  weekly_max: 0.8,
  pace_slack: 0.1,
};

export const BUDGET_KEYS = Object.keys(DEFAULT_BUDGET) as (keyof Budget)[];

export interface WindowObs {
  window: string;
  utilization: number;
  resets_at: number;
}

export interface Decision {
  allow: boolean;
  max_concurrent: number;
  /** Why work is held or throttled; null when running freely. */
  reason: string | null;
  /** When a hold is expected to lift (unix seconds). */
  until: number | null;
  /** Weekly pacing: how much of the 7d window the plan allows right now. */
  weekly_allowed: number | null;
}

const WEEK = 7 * 86400;

function current(windows: WindowObs[], name: string, now: number): WindowObs | null {
  const w = windows.find((x) => x.window === name);
  return w && w.resets_at > now ? w : null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function decide(windows: WindowObs[], budget: Budget, maxConcurrent: number, now: number): Decision {
  const holds: { reason: string; until: number }[] = [];
  let max = maxConcurrent;
  let throttle: string | null = null;
  let weeklyAllowed: number | null = null;

  const five = current(windows, 'five_hour', now);
  if (five) {
    if (five.utilization >= budget.five_hour_max) {
      holds.push({ reason: `5h usage ${pct(five.utilization)} ≥ cap ${pct(budget.five_hour_max)}`, until: five.resets_at });
    } else if (five.utilization >= budget.five_hour_soft && max > 1) {
      max = 1;
      throttle = `5h usage ${pct(five.utilization)}: one task at a time`;
    }
  }

  const week = current(windows, 'seven_day', now);
  if (week) {
    const start = week.resets_at - WEEK;
    const frac = Math.min(1, Math.max(0, (now - start) / WEEK));
    weeklyAllowed = Math.min(budget.weekly_max, budget.weekly_max * frac + budget.pace_slack);
    if (week.utilization >= budget.weekly_max) {
      holds.push({ reason: `7d usage ${pct(week.utilization)} ≥ cap ${pct(budget.weekly_max)}`, until: week.resets_at });
    } else if (week.utilization > weeklyAllowed) {
      const catchUp = start + ((week.utilization - budget.pace_slack) / budget.weekly_max) * WEEK;
      holds.push({
        reason: `7d usage ${pct(week.utilization)} is ahead of pace (${pct(weeklyAllowed)} allowed now)`,
        until: Math.min(week.resets_at, Math.ceil(catchUp)),
      });
    }
  }

  if (holds.length) {
    const h = holds.reduce((a, b) => (b.until > a.until ? b : a));
    return {
      allow: false,
      max_concurrent: max,
      reason: holds.map((x) => x.reason).join('; '),
      until: h.until,
      weekly_allowed: weeklyAllowed,
    };
  }
  return { allow: true, max_concurrent: max, reason: throttle, until: null, weekly_allowed: weeklyAllowed };
}

export function validateBudget(b: Budget): string | null {
  for (const k of BUDGET_KEYS) {
    if (!(b[k] >= 0 && b[k] <= 1)) return `${k} must be between 0 and 1`;
  }
  if (b.five_hour_soft > b.five_hour_max) return 'five_hour_soft must not exceed five_hour_max';
  return null;
}

export const validateSlots = (value: unknown): string | null => wholeNumberError('max_concurrent', value, 1, 8);
