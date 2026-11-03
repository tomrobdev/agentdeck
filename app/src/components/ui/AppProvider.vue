<script setup lang="ts">
import { ConfigProvider } from 'reka-ui';

// Reka's app-wide settings (text direction, scroll lock, ids). The app mounts inside it so every Reka part reads one config.
</script>

<template>
  <ConfigProvider>
    <slot />
  </ConfigProvider>
</template>
