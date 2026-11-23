<script setup lang="ts">
import { openExternal } from '#platform/native.ts';
import type { ParentHead } from '#lib/work/parent-groups.ts';

defineProps<{ head: ParentHead }>();
</script>

<template>
  <span class="flex min-w-0 items-center gap-2.5 text-sm text-muted" data-parent-head>
    <button v-if="head.url" class="btn-ghost flex-none text-accent" @click.stop="openExternal(head.url)">GH #{{ head.number }} ↗</button>
    <span v-if="head.total" class="flex-none tabular-nums">{{ head.done }} of {{ head.total }} done</span>
    <code v-if="head.merges" class="truncate" :title="head.merges">{{ head.merges }}</code>
  </span>
</template>
