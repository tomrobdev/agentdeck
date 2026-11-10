<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 18 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" class="flex-none">
    <rect x="2" y="2" width="20" height="20" rx="3" fill="currentColor" />
    <path d="M7 16 L12 7 L17 16" fill="none" stroke="var(--panel)" stroke-width="2.4" stroke-linejoin="miter" />
  </svg>
</template>
