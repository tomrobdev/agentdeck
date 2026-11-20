import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TaskSummary } from '#api/types.ts';
import { type Display, boardGroups, normalizeDisplay, rowOrder } from '#lib/work/queue/queue-display.ts';
import { loadSetting, saveSetting } from '#lib/shared/storage.ts';
import { type Filters, applyFilters, emptyFilters, groupTasks } from '#lib/work/task-view.ts';
import { requestedView } from '#composables/work/queue/useView.ts';

const MODES: Display['mode'][] = ['list', 'board', 'graph', 'running'];

export function useQueueDisplay(tasks: () => TaskSummary[]) {
  const route = useRoute();
  const router = useRouter();
  const display = ref<Display>(normalizeDisplay(loadSetting<unknown>('display', null), loadSetting<boolean>('doneCollapsed', false)));
  saveSetting('doneCollapsed', true);
  watch(
    requestedView,
    (mode) => {
      if (!mode) return;
      display.value = { ...display.value, mode };
      requestedView.value = null;
    },
    { immediate: true },
  );
  const saved = loadSetting<Omit<Filters, 'search'>>('filters', { states: [], repos: [], source: null });
  const filters = ref<Filters>({ ...emptyFilters(), ...saved, search: '' });
  watch(display, (d) => saveSetting('display', d), { deep: true });
  watch(filters, ({ search: _, ...f }) => saveSetting('filters', f), { deep: true });
  watch(
    () => route.query.states,
    (raw) => {
      if (route.name !== 'queue') return;
      const states = (Array.isArray(raw) ? raw[0] : raw)?.split(',').filter(Boolean) ?? [];
      if (!states.length) return;
      filters.value = { ...emptyFilters(), states };
      void router.replace({ name: 'queue' });
    },
    { immediate: true },
  );

  const shown = computed(() => applyFilters(tasks(), filters.value));
  const groups = computed(() => {
    const board = display.value.mode === 'board';
    const all = groupTasks(shown.value, board ? 'status' : display.value.groupBy, display.value.sort);
    return board ? boardGroups(all) : all;
  });
  const order = computed(() => rowOrder(groups.value, display.value));

  function toggleGroup(key: string) {
    const c = display.value.collapsed;
    display.value = { ...display.value, collapsed: c.includes(key) ? c.filter((k) => k !== key) : [...c, key] };
  }
  const nextMode = () => (display.value = { ...display.value, mode: MODES[(MODES.indexOf(display.value.mode) + 1) % MODES.length] });

  return { display, filters, shown, groups, order, toggleGroup, nextMode };
}
