<script setup lang="ts">
import { GROUP_BYS, type GroupBy, SORTS } from '../../taskView';
import type { ShowProps } from './ListView.vue';
import Popover from './Popover.vue';

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
    <template #trigger><button class="trig">Display ▾</button></template>
    <div class="line">
      <span>Grouping</span>
      <select
        :value="display.groupBy"
        :disabled="display.mode === 'board'"
        :title="display.mode === 'board' ? 'The board is always grouped by status' : ''"
        @change="set({ groupBy: ($event.target as HTMLSelectElement).value as GroupBy })"
      >
        <option v-for="g in GROUP_BYS" :key="g.key" :value="g.key">{{ g.label }}</option>
      </select>
    </div>
    <div class="line">
      <span>Ordering</span>
      <select :value="display.sort" @change="set({ sort: ($event.target as HTMLSelectElement).value })">
        <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
      </select>
    </div>
    <label class="line">
      <span>Show empty groups</span>
      <input type="checkbox" :checked="display.showEmpty" @change="set({ showEmpty: !display.showEmpty })" />
    </label>
    <div class="sec">Properties</div>
    <div class="props">
      <button
        v-for="p in PROPS"
        :key="p.key"
        class="prop"
        :class="{ on: display.show[p.key] }"
        :aria-pressed="display.show[p.key]"
        @click="set({ show: { ...display.show, [p.key]: !display.show[p.key] } })"
      >
        {{ p.label }}
      </button>
    </div>
  </Popover>
</template>

<style scoped>
.trig {
  padding: 2px 10px;
}
.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 8px;
}
.line select {
  width: 150px;
  padding: 2px 6px;
}
.line input {
  width: auto;
}
.sec {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  padding: 10px 8px 4px;
}
.props {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 8px 6px;
}
.prop {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--muted);
  background: none;
}
.prop.on {
  color: var(--text);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
}
</style>
