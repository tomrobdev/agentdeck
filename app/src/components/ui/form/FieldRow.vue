<script setup lang="ts">
withDefaults(defineProps<{ label: string; hint?: string; as?: 'label' | 'div' }>(), { hint: '', as: 'label' });
</script>

<template>
  <component :is="as" class="grid gap-x-6 gap-y-1.5 py-3 @xl:grid-cols-[15rem_minmax(0,1fr)]">
    <span class="flex flex-col gap-0.5">
      <span class="font-medium">{{ label }}</span>
      <small v-if="hint || $slots.hint" class="text-muted text-xs leading-snug"
        ><slot name="hint">{{ hint }}</slot></small
      >
    </span>
    <span
      class="flex min-w-0 flex-col items-start gap-1.5 @xl:pt-0.5 [&>input]:self-stretch [&>select]:w-full [&>select]:max-w-sm [&>textarea]:self-stretch"
    >
      <slot />
    </span>
  </component>
</template>
