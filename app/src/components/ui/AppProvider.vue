<script setup lang="ts">
import { ConfigProvider, TooltipProvider } from 'reka-ui';

// Reka's app-wide settings (text direction, scroll lock, ids) and the tooltips' shared delay. The app mounts inside it so
// every Reka part reads one config.
</script>

<template>
  <ConfigProvider>
    <TooltipProvider :delay-duration="300">
      <slot />
    </TooltipProvider>
  </ConfigProvider>
</template>
