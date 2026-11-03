<script setup lang="ts">
import { GROUP_BYS, type GroupBy, SORT_OPTIONS } from '../../lib/taskView';
import type { ShowProps } from './ListView.vue';
import ChipToggle from '../ui/ChipToggle.vue';
import Popover from '../ui/Popover.vue';

export interface Display {
  mode: 'list' | 'board' | 'graph';
  groupBy: GroupBy;
  sort: string;
  show: ShowProps;
  showEmpty: boolean;
  collapsed: string[];
  /** Graph mode: also draw chains whose every task is done and merged. Missing from a saved view that predates it. */
  showFinished?: boolean;
}

const display = defineModel<Display>({ required: true });
const set = (patch: Partial<Display>) => (display.value = { ...display.value, ...patch });
const PROPS: { key: keyof ShowProps; label: string }[] = [
  { key: 'repo', label: 'Repo' },
  { key: 'pr', label: 'Pull request' },
  { key: 'reason', label: 'Blocked reason' },
  { key: 'time', label: 'Updated' },
];
</script>

<template>
  <Popover align="right">
    <template #trigger><button class="px-2.5 py-0.5">Display ▾</button></template>
    <div class="flex items-center justify-between gap-3 px-2 py-1">
      <span>Grouping</span>
      <select
        class="w-[150px] px-1.5 py-0.5"
        :value="display.groupBy"
        :disabled="display.mode !== 'list'"
        :title="
          display.mode === 'board' ? 'The board is always grouped by status' : display.mode === 'graph' ? 'The graph is not grouped' : ''
        "
        @change="set({ groupBy: ($event.target as HTMLSelectElement).value as GroupBy })"
      >
        <option v-for="g in GROUP_BYS" :key="g.key" :value="g.key">{{ g.label }}</option>
      </select>
    </div>
    <div class="flex items-center justify-between gap-3 px-2 py-1">
      <span>Ordering</span>
      <select class="w-[150px] px-1.5 py-0.5" :value="display.sort" @change="set({ sort: ($event.target as HTMLSelectElement).value })">
        <option v-for="s in SORT_OPTIONS" :key="s.key" :value="s.key">{{ s.label }}</option>
      </select>
    </div>
    <label class="flex items-center justify-between gap-3 px-2 py-1">
      <span>Show empty groups</span>
      <input type="checkbox" :checked="display.showEmpty" @change="set({ showEmpty: !display.showEmpty })" />
    </label>
    <label class="flex items-center justify-between gap-3 px-2 py-1">
      <span>Show finished (graph)</span>
      <input type="checkbox" :checked="!!display.showFinished" @change="set({ showFinished: !display.showFinished })" />
    </label>
    <div class="px-2 pt-2.5 pb-1 text-xs tracking-[0.05em] text-muted uppercase">Properties</div>
    <div class="flex flex-wrap gap-1 px-2 pb-1.5">
      <ChipToggle
        v-for="p in PROPS"
        :key="p.key"
        :model-value="display.show[p.key]"
        @update:model-value="(on) => set({ show: { ...display.show, [p.key]: on } })"
      >
        {{ p.label }}
      </ChipToggle>
    </div>
  </Popover>
</template>
