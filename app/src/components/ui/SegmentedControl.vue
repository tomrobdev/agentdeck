<script setup lang="ts" generic="T extends string">
import { ToggleGroupItem, ToggleGroupRoot } from 'reka-ui';

// A row of options, exactly one of them on (never empty). A click on the one that is on changes nothing.
defineProps<{ options: { value: T; label: string; title?: string }[]; label: string }>();
const model = defineModel<T>({ required: true });
</script>

<template>
  <ToggleGroupRoot
    type="single"
    class="seg-control"
    :model-value="model"
    :aria-label="label"
    @update:model-value="(v) => v && (model = v as T)"
  >
    <ToggleGroupItem v-for="o in options" :key="o.value" :value="o.value" :title="o.title">{{ o.label }}</ToggleGroupItem>
  </ToggleGroupRoot>
</template>

<style scoped>
.seg-control {
  display: flex;
  flex: none;
  border: 1px solid var(--rule, var(--border));
  border-radius: var(--r-chip, 999px);
  overflow: hidden;
}
.seg-control > :deep(button) {
  flex: 1;
  border: none;
  border-radius: 0;
  background: none;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--muted);
}
.seg-control > :deep(button[data-state='on']) {
  background: var(--panel-2);
  color: var(--text);
  font-weight: 600;
}
:global(:root[data-theme='contrast']) .seg-control > :deep(button[data-state='on']) {
  background: var(--text);
  color: var(--bg);
}
</style>
