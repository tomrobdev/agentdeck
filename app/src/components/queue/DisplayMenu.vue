<script setup lang="ts">
import { GROUP_BYS, type GroupBy, SORT_OPTIONS } from '../../lib/taskView';
import type { ShowProps } from './ListView.vue';
import Popover from '../ui/Popover.vue';

export interface Display {
  mode: 'list' | 'board';
  groupBy: GroupBy;
  sort: string;
  show: ShowProps;
  showEmpty: boolean;
  collapsed: string[];
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
        :disabled="display.mode === 'board'"
        :title="display.mode === 'board' ? 'The board is always grouped by status' : ''"
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
    <div class="px-2 pt-2.5 pb-1 text-xs tracking-[0.05em] text-muted uppercase">Properties</div>
    <div class="flex flex-wrap gap-1 px-2 pb-1.5">
      <button
        v-for="p in PROPS"
        :key="p.key"
        class="rounded-pill px-2 py-px text-sm"
        :class="
          display.show[p.key]
            ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel))] text-text'
            : 'bg-transparent text-muted'
        "
        :aria-pressed="display.show[p.key]"
        @click="set({ show: { ...display.show, [p.key]: !display.show[p.key] } })"
      >
        {{ p.label }}
      </button>
    </div>
  </Popover>
</template>
