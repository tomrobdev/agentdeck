<script setup lang="ts">
import { computed } from 'vue';
import { PRIORITY_LEVELS, priorityLevel } from '../../taskView';

const props = defineProps<{ priority: number }>();

const level = computed(() => priorityLevel(props.priority));
const bars = computed(() => ({ none: 0, low: 1, medium: 2, high: 3, urgent: 3 })[level.value]);
const title = computed(() => `${PRIORITY_LEVELS.find((l) => l.key === level.value)!.label} · priority ${props.priority}`);
</script>

<template>
  <svg class="block flex-none" :class="`p-${level}`" width="14" height="14" viewBox="0 0 14 14" role="img" :aria-label="title">
    <title>{{ title }}</title>
    <template v-if="level === 'urgent'">
      <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="var(--failed)" />
      <path d="M7 4v3.6" stroke="var(--panel)" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="7" cy="9.8" r="0.9" fill="var(--panel)" />
    </template>
    <template v-else-if="level === 'none'">
      <path d="M2 7h2M6 7h2M10 7h2" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" />
    </template>
    <template v-else>
      <rect
        v-for="i in 3"
        :key="i"
        :x="1.5 + (i - 1) * 4"
        :y="10 - i * 2.6"
        width="3"
        :height="2 + i * 2.6"
        rx="0.8"
        :fill="i <= bars ? 'var(--text)' : 'var(--border)'"
      />
    </template>
  </svg>
</template>
