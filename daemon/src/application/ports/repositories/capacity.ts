// Capacity's repository: the usage windows Claude reports, and their history.

export interface UsageRepository {
  recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void;
  usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[];
  usageSamples(window?: string): { window: string; utilization: number; resets_at: number; observed_at: string }[];
}
