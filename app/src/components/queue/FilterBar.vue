<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TaskSummary } from '../../api';
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

// "/" jumps to the search box, Escape leaves it.
function onKey(e: KeyboardEvent) {
  const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    search.value?.focus();
  } else if (e.key === 'Escape' && e.target === search.value) {
    set({ search: '' });
    search.value?.blur();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="fbar">
    <span v-if="filters.states.length" class="fchip">
      <span class="muted">Status is</span> {{ filters.states.map(labelOf).join(', ') }}
      <button class="x" aria-label="Remove status filter" @click="set({ states: [] })">×</button>
    </span>
    <span v-if="filters.repos.length" class="fchip">
      <span class="muted">Repo is</span> {{ filters.repos.join(', ') }}
      <button class="x" aria-label="Remove repo filter" @click="set({ repos: [] })">×</button>
    </span>
    <span v-if="filters.source" class="fchip">
      <span class="muted">Source is</span> {{ filters.source }}
      <button class="x" aria-label="Remove source filter" @click="set({ source: null })">×</button>
    </span>
    <Popover>
      <template #trigger><button class="add">+ Filter</button></template>
      <div class="sec">Status</div>
      <label v-for="s in STATES" :key="s.key" class="opt">
        <input type="checkbox" :checked="filters.states.includes(s.key)" @change="toggle('states', s.key)" />
        <span>{{ s.label }}</span
        ><span class="n">{{ stateCounts[s.key] }}</span>
      </label>
      <template v-if="repos.length > 1">
        <div class="sec">Repo</div>
        <label v-for="r in repos" :key="r" class="opt">
          <input type="checkbox" :checked="filters.repos.includes(r)" @change="toggle('repos', r)" />
          <span>{{ r }}</span
          ><span class="n">{{ repoCounts[r] }}</span>
        </label>
      </template>
      <div class="sec">Source</div>
      <label v-for="src in ['manual', 'planner'] as const" :key="src" class="opt">
        <input type="radio" :checked="filters.source === src" @change="set({ source: src })" />
        <span>{{ src === 'manual' ? 'Added by you' : 'Planner' }}</span>
      </label>
    </Popover>
    <button v-if="hasFilters(filters)" class="clear" @click="filters = { states: [], repos: [], source: null, search: '' }">Clear</button>
    <div class="spacer" />
    <input
      ref="search"
      class="search"
      type="search"
      placeholder="Search  /"
      :value="filters.search"
      @input="set({ search: ($event.target as HTMLInputElement).value })"
    />
  </div>
</template>

<style scoped>
.fbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
  flex: 1;
}
.fchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 2px 1px 8px;
  font-size: 12px;
  background: var(--panel);
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.x {
  border: none;
  background: none;
  padding: 0 5px;
  color: var(--muted);
}
.add,
.clear {
  border: 1px dashed var(--border);
  background: none;
  padding: 1px 8px;
  font-size: 12px;
  color: var(--muted);
}
.clear {
  border: none;
}
.spacer {
  flex: 1;
}
.search {
  width: 200px;
  padding: 3px 8px;
}
.sec {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  padding: 8px 8px 2px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.opt:hover {
  background: var(--panel-2);
}
.opt input {
  width: auto;
  margin: 0;
}
.opt span:first-of-type {
  flex: 1;
}
.n {
  color: var(--muted);
  font-size: 12px;
}
@media (max-width: 720px) {
  .search {
    width: 100%;
  }
}
</style>
