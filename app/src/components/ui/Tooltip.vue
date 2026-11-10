<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from 'reka-ui';

defineProps<{ text: string; side?: 'top' | 'bottom' }>();
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child><slot /></TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        :side="side ?? 'top'"
        :side-offset="6"
        :collision-padding="8"
        class="z-50 max-w-[360px] rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs whitespace-pre-line text-text shadow-popover"
      >
        {{ text }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
