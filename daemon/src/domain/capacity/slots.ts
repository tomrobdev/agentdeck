// The slots: work slots for tasks, resolve runs and the planner, and support slots that review, unblock and verify runs fill first.
import { plural, wholeNumberError } from '#domain/shared/index.ts';

export const DEFAULT_SUPPORT_SLOTS = 1;

export const validateSupportSlots = (value: unknown): string | null => wholeNumberError('support_slots', value, 0, 4);

export interface SlotsTaken {
  used: number;
  support: number;
  support_slots: number;
}

export function slotUse(s: SlotsTaken): { work: number; support_free: number } {
  const support = Math.max(0, Math.min(s.support, s.used));
  return { work: s.used - Math.min(support, s.support_slots), support_free: Math.max(0, s.support_slots - support) };
}

export interface SupportRuns {
  review: number;
  unblock: number;
  verify: number;
}

const SUPPORT_KINDS = ['review', 'unblock', 'verify'] as const;

export function slotsLine(running: number, max: number, support: SupportRuns): string {
  const kinds = SUPPORT_KINDS.filter((k) => support[k] > 0).map((k) => plural(support[k], k));
  return [`${running}/${max} slots`, ...kinds].join(' · ');
}
