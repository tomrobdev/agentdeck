<script setup lang="ts">
defineProps<{ add: number; del: number }>();
</script>

<template>
  <span class="inline-flex flex-none gap-1.5 font-mono leading-[normal] whitespace-nowrap">
    <span class="text-done">+{{ add }}</span
    ><span class="text-failed">−{{ del }}</span>
  </span>
</template>
