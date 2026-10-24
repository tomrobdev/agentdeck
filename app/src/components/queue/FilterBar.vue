<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TaskSummary } from '../../api';
import { useHotkeys } from '../../hotkeys';
import { type Filters, STATES, hasFilters } from '../../taskView';
import Popover from './Popover.vue';

const props = defineProps<{ tasks: TaskSummary[] }>();
const filters = defineModel<Filters>({ required: true });

const search = ref<HTMLInputElement | null>(null);
const repos = computed(() => [...new Set(props.tasks.map((t) => t.repo ?? '?'))].sort());
const stateCounts = computed(() => Object.fromEntries(STATES.map((s) => [s.key, props.tasks.filter(s.test).length])));
const repoCounts = computed(() => Object.fromEntries(repos.value.map((r) => [r, props.tasks.filter((t) => (t.repo ?? '?') === r).length])));
const labelOf = (key: string) => STATES.find((s) => s.key === key)?.label ?? key;

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
    <span
      v-if="filters.states.length"
      class="inline-flex max-w-[320px] items-center gap-1 truncate rounded-sm border border-border bg-panel py-px pr-0.5 pl-2 text-sm"
    >
      <span class="muted">Status is</span> {{ filters.states.map(labelOf).join(', ') }}
      <button
        class="rounded-sm border-0 bg-transparent px-[5px] py-0 text-muted"
        aria-label="Remove status filter"
        @click="set({ states: [] })"
      >
        ×
      </button>
    </span>
    <span
      v-if="filters.repos.length"
      class="inline-flex max-w-[320px] items-center gap-1 truncate rounded-sm border border-border bg-panel py-px pr-0.5 pl-2 text-sm"
    >
      <span class="muted">Repo is</span> {{ filters.repos.join(', ') }}
      <button
        class="rounded-sm border-0 bg-transparent px-[5px] py-0 text-muted"
        aria-label="Remove repo filter"
        @click="set({ repos: [] })"
      >
        ×
      </button>
    </span>
    <span
      v-if="filters.source"
      class="inline-flex max-w-[320px] items-center gap-1 truncate rounded-sm border border-border bg-panel py-px pr-0.5 pl-2 text-sm"
    >
      <span class="muted">Source is</span> {{ filters.source }}
      <button
        class="rounded-sm border-0 bg-transparent px-[5px] py-0 text-muted"
        aria-label="Remove source filter"
        @click="set({ source: null })"
      >
        ×
      </button>
    </span>
    <Popover>
      <template #trigger><button class="border-dashed bg-transparent px-2 py-px text-sm text-muted">+ Filter</button></template>
      <div class="px-2 pt-2 pb-0.5 text-xs tracking-[0.05em] text-muted uppercase">Status</div>
      <label v-for="s in STATES" :key="s.key" class="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[3px] hover:bg-panel-2">
        <input class="m-0" type="checkbox" :checked="filters.states.includes(s.key)" @change="toggle('states', s.key)" />
        <span class="flex-1">{{ s.label }}</span
        ><span class="text-sm text-muted">{{ stateCounts[s.key] }}</span>
      </label>
      <template v-if="repos.length > 1">
        <div class="px-2 pt-2 pb-0.5 text-xs tracking-[0.05em] text-muted uppercase">Repo</div>
        <label v-for="r in repos" :key="r" class="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[3px] hover:bg-panel-2">
          <input class="m-0" type="checkbox" :checked="filters.repos.includes(r)" @change="toggle('repos', r)" />
          <span class="flex-1">{{ r }}</span
          ><span class="text-sm text-muted">{{ repoCounts[r] }}</span>
        </label>
      </template>
      <div class="px-2 pt-2 pb-0.5 text-xs tracking-[0.05em] text-muted uppercase">Source</div>
      <label
        v-for="src in ['manual', 'planner'] as const"
        :key="src"
        class="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[3px] hover:bg-panel-2"
      >
        <input class="m-0" type="radio" :checked="filters.source === src" @change="set({ source: src })" />
        <span class="flex-1">{{ src === 'manual' ? 'Added by you' : 'Planner' }}</span>
      </label>
    </Popover>
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
