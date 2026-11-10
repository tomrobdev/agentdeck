<script setup lang="ts">
import { ProgressIndicator, ProgressRoot } from 'reka-ui';

const props = withDefaults(defineProps<{ value: number; max?: number; label: string; indicatorClass?: string }>(), { max: 100 });
</script>

<template>
  <ProgressRoot :model-value="props.value" :max="props.max" :aria-label="label">
    <ProgressIndicator
      class="block h-full"
      :class="indicatorClass"
      :style="{ width: `${props.max ? Math.min(100, (100 * props.value) / props.max) : 0}%` }"
    />
    <slot />
  </ProgressRoot>
</template>
