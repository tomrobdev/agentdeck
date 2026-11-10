<script setup lang="ts">
import { ConfigProvider, TooltipProvider } from 'reka-ui';
</script>

<template>
  <ConfigProvider>
    <TooltipProvider :delay-duration="300">
      <slot />
    </TooltipProvider>
  </ConfigProvider>
</template>
