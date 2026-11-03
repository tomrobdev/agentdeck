<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TaskSummary } from '../../api';
import { useHotkeys } from '../../composables/useHotkeys';
import { FILTER_STATES, type Filters, hasFilters } from '../../lib/taskView';
import Chip from '../ui/Chip.vue';
import Menu from '../ui/Menu.vue';
import MenuCheckboxItem from '../ui/MenuCheckboxItem.vue';
import MenuLabel from '../ui/MenuLabel.vue';
import MenuRadioGroup from '../ui/MenuRadioGroup.vue';
import MenuRadioItem from '../ui/MenuRadioItem.vue';

const props = defineProps<{ tasks: TaskSummary[] }>();
const filters = defineModel<Filters>({ required: true });

const search = ref<HTMLInputElement | null>(null);
const repos = computed(() => [...new Set(props.tasks.map((t) => t.repo ?? '?'))].sort());
const stateCounts = computed(() => Object.fromEntries(FILTER_STATES.map((s) => [s.key, props.tasks.filter(s.test).length])));
const repoCounts = computed(() => Object.fromEntries(repos.value.map((r) => [r, props.tasks.filter((t) => (t.repo ?? '?') === r).length])));
const labelOf = (key: string) => FILTER_STATES.find((s) => s.key === key)?.label ?? key;

function toggle(list: 'states' | 'repos', key: string) {
  const cur = filters.value[list];
  filters.value = { ...filters.value, [list]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
}
const set = (patch: Partial<Filters>) => (filters.value = { ...filters.value, ...patch });

useHotkeys({ '/': () => search.value?.focus() });
function leaveSearch() {
  set({ search: '' });
  search.value?.blur();
}
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
    <Chip v-if="filters.states.length" removable remove-label="Remove status filter" class="max-w-[320px]" @remove="set({ states: [] })">
      <span class="truncate"><span class="text-muted">Status is</span> {{ filters.states.map(labelOf).join(', ') }}</span>
    </Chip>
    <Chip v-if="filters.repos.length" removable remove-label="Remove repo filter" class="max-w-[320px]" @remove="set({ repos: [] })">
      <span class="truncate"><span class="text-muted">Repo is</span> {{ filters.repos.join(', ') }}</span>
    </Chip>
    <Chip v-if="filters.source" removable remove-label="Remove source filter" class="max-w-[320px]" @remove="set({ source: null })">
      <span class="truncate"><span class="text-muted">Source is</span> {{ filters.source }}</span>
    </Chip>
    <Menu label="Add a filter">
      <template #trigger><button class="border-dashed bg-transparent px-2 py-px text-sm text-muted">+ Filter</button></template>
      <MenuLabel>Status</MenuLabel>
      <MenuCheckboxItem
        v-for="s in FILTER_STATES"
        :key="s.key"
        :checked="filters.states.includes(s.key)"
        @update:checked="toggle('states', s.key)"
      >
        <span class="flex-1">{{ s.label }}</span
        ><span class="text-sm text-muted">{{ stateCounts[s.key] }}</span>
      </MenuCheckboxItem>
      <template v-if="repos.length > 1">
        <MenuLabel>Repo</MenuLabel>
        <MenuCheckboxItem v-for="r in repos" :key="r" :checked="filters.repos.includes(r)" @update:checked="toggle('repos', r)">
          <span class="flex-1">{{ r }}</span
          ><span class="text-sm text-muted">{{ repoCounts[r] }}</span>
        </MenuCheckboxItem>
      </template>
      <MenuLabel>Source</MenuLabel>
      <MenuRadioGroup :model-value="filters.source ?? ''" @update:model-value="set({ source: $event as 'manual' | 'planner' })">
        <MenuRadioItem v-for="src in ['manual', 'planner'] as const" :key="src" :value="src" keep-open>
          <span class="flex-1">{{ src === 'manual' ? 'Added by you' : 'Planner' }}</span>
        </MenuRadioItem>
      </MenuRadioGroup>
    </Menu>
    <button
      v-if="hasFilters(filters)"
      class="border-0 bg-transparent px-2 py-px text-sm text-muted"
      @click="filters = { states: [], repos: [], source: null, search: '' }"
    >
      Clear
    </button>
    <div class="spacer" />
    <input
      ref="search"
      class="w-[200px] px-2 py-[3px] max-sm:w-full"
      type="search"
      placeholder="Search  /"
      :value="filters.search"
      @keydown.esc="leaveSearch"
      @input="set({ search: ($event.target as HTMLInputElement).value })"
    />
  </div>
</template>
