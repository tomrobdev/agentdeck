<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui';

// An on/off setting with its label beside it (the slot). Without a slot, give it a `label` for screen readers.
defineProps<{ label?: string }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="flex cursor-pointer items-center gap-2">
    <SwitchRoot
      :model-value="model"
      :aria-label="label"
      class="relative h-4 w-7 flex-none rounded-full border border-border bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      @update:model-value="(v) => (model = v)"
    >
      <SwitchThumb
        class="block size-2.5 translate-x-0.5 rounded-full bg-muted transition-transform data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-bg"
      />
    </SwitchRoot>
    <slot />
  </label>
</template>
