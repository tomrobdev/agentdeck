<script setup lang="ts">
// A run's final message, collapsed under a summary. The caller sets the size limits through class.
defineProps<{ open?: boolean }>();
</script>

<template>
  <details class="rounded-md border border-border bg-panel px-3.5 py-2 [&[open]>summary]:mb-2" :open="open">
    <summary class="cursor-pointer text-muted">Final message</summary>
    <slot />
  </details>
</template>
