// The queue's display and filters: remembered per browser, changed by the command palette's view request and by links
// that open the queue filtered, and the groups and rows they make of the tasks.
import { computed, ref, watch } from 'vue';
import type { TaskSummary } from '../../api/types';
import { type Display, boardGroups, normalizeDisplay, rowOrder } from '../../lib/queue/queue-display';
import { loadSetting, saveSetting } from '../../lib/shared/storage';
import { type Filters, applyFilters, emptyFilters, groupTasks } from '../../lib/task/task-view';
import { go, route } from '../../router';
import { requestedView } from '../shared/useView';

const MODES: Display['mode'][] = ['list', 'board', 'graph'];

export function useQueueDisplay(tasks: () => TaskSummary[]) {
  const display = ref<Display>(normalizeDisplay(loadSetting<unknown>('display', null), loadSetting<boolean>('doneCollapsed', false)));
  saveSetting('doneCollapsed', true);
  // The command palette asks for a view; apply it when it arrives (also when this mounts after the palette sent it).
  watch(
    requestedView,
    (mode) => {
      if (!mode) return;
      display.value = { ...display.value, mode };
      requestedView.value = null;
    },
    { immediate: true },
  );
  // The search box isn't remembered; the rest of the filters are.
  const saved = loadSetting<Omit<Filters, 'search'>>('filters', { states: [], repos: [], source: null });
  const filters = ref<Filters>({ ...emptyFilters(), ...saved, search: '' });
  watch(display, (d) => saveSetting('display', d), { deep: true });
  watch(filters, ({ search: _, ...f }) => saveSetting('filters', f), { deep: true });
  // A link such as the header's "need you" opens the queue filtered to some states; the filter then stays the user's.
  watch(
    () => route.current,
    (r) => {
      if (r.name !== 'queue' || !r.states) return;
      filters.value = { ...emptyFilters(), states: r.states };
      go({ name: 'queue' }, { replace: true });
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
