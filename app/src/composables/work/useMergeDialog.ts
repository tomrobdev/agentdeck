import type { MergeResult } from '../../api/types';
import type { Actions } from '../shared/useActions';
import { merging } from '../shared/useShell';
import { useOpenNext } from './queue/useOpenNext';

export function useMergeDialog({ refresh, flash }: Pick<Actions, 'refresh' | 'flash'>) {
  const { nextAfter, openNext } = useOpenNext();
  function onRequested(next: boolean) {
    const id = merging.value;
    merging.value = null;
    if (next && id !== null) openNext(id);
  }
  async function onMerged(result: MergeResult, next: boolean) {
    onRequested(next);
    await refresh();
    if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
  }
  const close = () => (merging.value = null);
  return { merging, nextAfter, onMerged, onRequested, close };
}
