import type { ProposalCheck } from '#daemon/api/contract/files.ts';
import { proposalCheckLine } from '#daemon/domain/work/index.ts';

export type ApproveDialogSetting = 'always' | 'needed' | 'never';
export const APPROVE_DIALOG_SETTINGS: { key: ApproveDialogSetting; label: string }[] = [
  { key: 'needed', label: 'When there is something to show' },
  { key: 'always', label: 'Always' },
  { key: 'never', label: 'Never' },
];
export const DEFAULT_APPROVE_DIALOG: ApproveDialogSetting = 'needed';

export interface ApproveItem {
  id: number;
  check: ProposalCheck | null;
}

export const hasSomethingToShow = (check: ProposalCheck | null): boolean =>
  !!check && (proposalCheckLine(check) !== null || check.notes.length > 0 || check.overlaps.some((o) => !o.linked));

export interface ApprovePlan {
  open: boolean;
  listed: number[];
  ticked: number[];
}

export function approveDialog(items: ApproveItem[], setting: ApproveDialogSetting): ApprovePlan {
  const listed = items.map((i) => i.id);
  const open = items.length > 0 && setting !== 'never' && (setting === 'always' || items.some((i) => hasSomethingToShow(i.check)));
  if (!open) return { open: false, listed: [], ticked: [] };
  const ticked = items.length === 1 ? listed : items.filter((i) => !hasSomethingToShow(i.check)).map((i) => i.id);
  return { open, listed, ticked };
}

export const asApproveDialogSetting = (v: unknown): ApproveDialogSetting =>
  APPROVE_DIALOG_SETTINGS.some((s) => s.key === v) ? (v as ApproveDialogSetting) : DEFAULT_APPROVE_DIALOG;
