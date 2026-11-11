import { type InjectionKey, type Ref, inject, provide, ref } from 'vue';
import type { QueryClient } from '@tanstack/vue-query';
import { errorMessage } from '#daemon/domain/shared/index.ts';
import { PERSON_CALLS, proposalCheckQuery } from '#api/work.ts';
import {
  type ApproveDialogSetting,
  type ApproveItem,
  type ApprovePlan,
  DEFAULT_APPROVE_DIALOG,
  approveDialog,
  asApproveDialogSetting,
} from '#lib/work/approve-dialog.ts';
import { type BulkResult, bulkMessage } from '#lib/work/queue/bulk.ts';
import { loadSetting, saveSetting } from '#lib/shared/storage.ts';
import type { Actions } from '#composables/shared/useActions.ts';

export type Approvals = {
  approve: (ids: number[]) => Promise<BulkResult[] | null>;
  approving: Ref<ApproveRequest | null>;
  answer: (results: BulkResult[] | null) => void;
};

const KEY: InjectionKey<Approvals> = Symbol('approvals');

export type ApproveRequest = { items: ApproveItem[]; plan: ApprovePlan; resolve: (results: BulkResult[] | null) => void };

export function provideApprovals(queryClient: QueryClient, { refresh, flash }: Pick<Actions, 'refresh' | 'flash'>) {
  const approving = ref<ApproveRequest | null>(null);

  async function approveNow(ids: number[]): Promise<BulkResult[]> {
    const results: BulkResult[] = [];
    for (const id of ids) {
      try {
        await PERSON_CALLS.approve(id);
        results.push({ id });
      } catch (e) {
        results.push({ id, error: errorMessage(e) });
      }
    }
    await refresh();
    if (ids.length > 1 || results.some((r) => r.error !== undefined)) flash(bulkMessage('approve', results));
    return results;
  }

  async function approve(ids: number[]): Promise<BulkResult[] | null> {
    const setting = approveDialogSetting.value;
    if (setting === 'never') return approveNow(ids);
    const items = await Promise.all(
      ids.map(async (id) => ({
        id,
        check: await queryClient.fetchQuery({ ...proposalCheckQuery(id), staleTime: 0 }).catch(() => null),
      })),
    );
    const plan = approveDialog(items, setting);
    if (!plan.open) return approveNow(ids);
    return new Promise((resolve) => (approving.value = { items, plan, resolve }));
  }

  function answer(results: BulkResult[] | null) {
    approving.value?.resolve(results);
    approving.value = null;
  }

  const approvals: Approvals = { approve, approving, answer };
  provide(KEY, approvals);
  return approvals;
}

export function useApprovals(): Approvals {
  const approvals = inject(KEY);
  if (!approvals) throw new Error('useApprovals() needs App to provideApprovals() first');
  return approvals;
}

export const approveDialogSetting = ref<ApproveDialogSetting>(
  asApproveDialogSetting(loadSetting<unknown>('approveDialog', DEFAULT_APPROVE_DIALOG)),
);

export function setApproveDialogSetting(value: ApproveDialogSetting) {
  approveDialogSetting.value = value;
  saveSetting('approveDialog', value);
}
