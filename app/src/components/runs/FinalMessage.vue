<script setup lang="ts">
defineProps<{ open?: boolean }>();
</script>

<template>
  <details class="rounded-md border border-border bg-panel px-3.5 py-2 [&[open]>summary]:mb-2" :open="open">
    <summary class="cursor-pointer text-muted">Final message</summary>
    <slot />
  </details>
</template>
