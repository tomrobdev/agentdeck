// Quota spent, read from the readings of the 7-day window kept in `usage_samples`. Pure: no I/O.

/** A reading of the 7-day window, as kept in `usage_samples`: utilization is 0..1. */
export interface QuotaSample {
  utilization: number;
  resets_at: number;
  observed_at: string;
}

/**
 * Percentage points of the 7-day window spent between readings, each with the time it was seen. A reading higher than the
 * one before adds the difference. A lower one means the window reset, so everything it shows was spent since. The first
 * reading is only a baseline: what came before it was not seen.
 */
export function quotaSpends(samples: QuotaSample[]): { at: string; points: number }[] {
  return samples.flatMap((s, i) => {
    if (i === 0) return [];
    const before = samples[i - 1].utilization;
    const points = (s.utilization >= before ? s.utilization - before : s.utilization) * 100;
    return points > 0 ? [{ at: s.observed_at, points }] : [];
  });
}
