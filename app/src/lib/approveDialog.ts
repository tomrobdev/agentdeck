// When approving opens the dialog, and which tasks it lists. Free of the dashboard's other modules so the daemon's tests can
// import it (daemon/test/dashboard/queue/approve-dialog.test.ts). What there is to show about a task is the daemon's proposalCheckLine.
import type { ProposalCheck } from '../../../daemon/src/api/contract.ts';
import { proposalCheckLine } from '../../../daemon/src/domain/work/index.ts';

/** The dashboard's own setting: always open the dialog, open it when a task has something to show, or never. */
export type ApproveDialogSetting = 'always' | 'needed' | 'never';
export const APPROVE_DIALOG_SETTINGS: { key: ApproveDialogSetting; label: string }[] = [
  { key: 'needed', label: 'When there is something to show' },
  { key: 'always', label: 'Always' },
  { key: 'never', label: 'Never' },
];
export const DEFAULT_APPROVE_DIALOG: ApproveDialogSetting = 'needed';

/** A task being approved with its check; null when the check could not be read, which counts as nothing to show. */
export interface ApproveItem {
  id: number;
  check: ProposalCheck | null;
}

/** Whether a check has a staleness line, notes or overlaps to show. An overlap a link already joins is settled, so not one. */
export const hasSomethingToShow = (check: ProposalCheck | null): boolean =>
  !!check && (proposalCheckLine(check) !== null || check.notes.length > 0 || check.overlaps.some((o) => !o.linked));

export interface ApprovePlan {
  open: boolean;
  /** Every task the dialog lists, in the order given. */
  listed: number[];
  /** The ones already ticked: those with nothing to show, or all of them when only one task is listed. */
  ticked: number[];
}

/** Whether approving `items` opens the dialog, and what it lists and ticks. Never opens for no tasks. */
export function approveDialog(items: ApproveItem[], setting: ApproveDialogSetting): ApprovePlan {
  const listed = items.map((i) => i.id);
  const open = items.length > 0 && setting !== 'never' && (setting === 'always' || items.some((i) => hasSomethingToShow(i.check)));
  if (!open) return { open: false, listed: [], ticked: [] };
  const ticked = items.length === 1 ? listed : items.filter((i) => !hasSomethingToShow(i.check)).map((i) => i.id);
  return { open, listed, ticked };
}

/** Reads the stored setting; anything unknown is the default. */
export const asApproveDialogSetting = (v: unknown): ApproveDialogSetting =>
  APPROVE_DIALOG_SETTINGS.some((s) => s.key === v) ? (v as ApproveDialogSetting) : DEFAULT_APPROVE_DIALOG;
