// The picked tasks, shared by every view, the bulk bar and the palette: one selection for the whole queue.
import { ref } from 'vue';
import { idRange, keepPicked, pickAll, toggleGroupPicks } from '#lib/work/queue/bulk.ts';

const picked = ref<number[]>([]);
const anchor = ref<number | null>(null);

export function usePicked() {
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
  function keepIn(shown: number[]) {
    if (picked.value.some((id) => !shown.includes(id))) picked.value = keepPicked(picked.value, shown);
  }
  function setPicked(ids: number[]) {
    picked.value = ids;
  }
  return { picked, pick, pickMany, toggleGroup, clearPicked, keepIn, setPicked };
}
