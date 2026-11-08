// The one gate every approval passes through: the task page, the list row, the row menu, the `a` key, the palette, a board
// drag and the bulk bar all call `approve`. App provides it (it owns the dialog); components `useApprovals()` it.
import { type InjectionKey, inject, provide, ref } from 'vue';
import { type ApproveDialogSetting, DEFAULT_APPROVE_DIALOG, asApproveDialogSetting } from '../lib/approveDialog';
import type { BulkResult } from '../lib/bulk';
import { loadSetting, saveSetting } from '../lib/storage';

export type Approvals = {
  /**
   * Approves the tasks, after a dialog when one has something to show. Resolves with each task's result, or null when the
   * person dismissed the dialog and nothing was approved. It says what happened itself (a toast, or the dialog's own report).
   */
  approve: (ids: number[]) => Promise<BulkResult[] | null>;
};

const KEY: InjectionKey<Approvals> = Symbol('approvals');

export function provideApprovals(approvals: Approvals): Approvals {
  provide(KEY, approvals);
  return approvals;
}

export function useApprovals(): Approvals {
  const approvals = inject(KEY);
  if (!approvals) throw new Error('useApprovals() needs App to provideApprovals() first');
  return approvals;
}

/** The dashboard's own setting for when approving opens the dialog, kept on this computer; not a daemon setting. */
export const approveDialogSetting = ref<ApproveDialogSetting>(
  asApproveDialogSetting(loadSetting<unknown>('approveDialog', DEFAULT_APPROVE_DIALOG)),
);

export function setApproveDialogSetting(value: ApproveDialogSetting) {
  approveDialogSetting.value = value;
  saveSetting('approveDialog', value);
}
