<script setup lang="ts">
import type { Tone } from '#lib/shared/tone.ts';
import { openExternal } from '#platform/native.ts';
import Chip from '#components/ui/Chip.vue';

defineProps<{ url: string; tip: string; label: string; icon: string; tone?: Tone; plain?: boolean }>();
</script>

<template>
  <component
    :is="plain ? 'button' : Chip"
    v-bind="plain ? { type: 'button' } : { as: 'button', tone }"
    class="cursor-pointer font-mono whitespace-nowrap hover:text-accent"
    :class="plain && 'btn-ghost inline-flex items-center gap-[5px] p-0 text-sm text-muted'"
    :title="tip"
    :aria-label="tip"
    @click.stop="openExternal(url)"
  >
    <svg class="block flex-none" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path :d="icon" /></svg>
    <span>{{ label }}</span>
  </component>
</template>
