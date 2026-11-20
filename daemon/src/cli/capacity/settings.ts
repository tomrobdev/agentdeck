import { type SettingsPatch } from '#application/actions.ts';
import { BUDGET_KEYS } from '#domain/capacity/index.ts';

export const CAPACITY_SETTINGS: Record<string, (value: string, key: string) => SettingsPatch> = {
  max_concurrent: (value) => ({ max_concurrent: Number(value) }),
  ...Object.fromEntries(
    (BUDGET_KEYS as string[]).map((budgetKey): [string, (value: string) => SettingsPatch] => [
      budgetKey,
      (value) => ({ budget: { [budgetKey]: Number(value) } }),
    ]),
  ),
};
