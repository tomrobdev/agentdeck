<script setup lang="ts">
withDefaults(defineProps<{ title: string; id?: string; hint?: string; instant?: boolean }>(), { id: undefined, hint: '', instant: false });
</script>

<template>
  <section :id="id" class="@container scroll-mt-2">
    <header class="flex flex-col gap-1 border-b border-border pb-2">
      <h3 class="m-0 flex items-center gap-2 text-base font-semibold">
        {{ title }}
        <span v-if="instant" class="rounded-sm border border-border px-1.5 text-xs font-normal text-muted">applies at once</span>
      </h3>
      <p v-if="hint" class="text-muted m-0 text-sm">{{ hint }}</p>
    </header>
    <div class="flex flex-col divide-y divide-border">
      <slot />
    </div>
  </section>
</template>
