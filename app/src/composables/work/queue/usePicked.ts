// The picked tasks, shared by every view, the bulk bar and the palette: one selection for the whole queue.
// Module state is fine here: the dashboard is one page, and the selection is the person's, not the daemon's.
import { ref } from 'vue';
import { idRange, keepPicked, pickAll, toggleGroupPicks } from '../../../lib/work/queue/bulk';

const picked = ref<number[]>([]);
const anchor = ref<number | null>(null);

export function usePicked() {
  /** Pick or unpick one task; with `range`, pick from the last one to this in `order` (a column's, the list's). */
  function pick(id: number, range: boolean, order: number[] = []) {
    if (range) picked.value = pickAll(picked.value, idRange(order, anchor.value, id));
    else picked.value = picked.value.includes(id) ? picked.value.filter((p) => p !== id) : [...picked.value, id];
    anchor.value = id;
  }
  function pickMany(ids: number[]) {
    picked.value = pickAll(picked.value, ids);
  }
  function toggleGroup(ids: number[]) {
    picked.value = toggleGroupPicks(picked.value, ids);
  }
  function clearPicked() {
    picked.value = [];
    anchor.value = null;
  }
  /** Drop the picks that left the filtered set. */
  function keepIn(shown: number[]) {
    if (picked.value.some((id) => !shown.includes(id))) picked.value = keepPicked(picked.value, shown);
  }
  function setPicked(ids: number[]) {
    picked.value = ids;
  }
  return { picked, pick, pickMany, toggleGroup, clearPicked, keepIn, setPicked };
}
