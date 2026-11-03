<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from 'reka-ui';

// A hover and focus hint for text of more than a line (new lines are kept). The slot is the trigger and gets the hint's
// handlers, so it must be one element or component that takes attributes, and the hint is also its accessible description.
// A one-line hint stays a plain `title=`. Needs the TooltipProvider in AppProvider.
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
