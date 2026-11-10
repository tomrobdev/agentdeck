<script setup lang="ts" generic="K extends string">
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { type RouteLocationRaw, RouterLink } from 'vue-router';
import Chip from './Chip.vue';

defineProps<{ tabs: { key: K; label: string; count: number | null }[]; label: string; to: (key: K) => RouteLocationRaw }>();
const model = defineModel<K>({ required: true });
</script>

<template>
  <TabsRoot :model-value="model" activation-mode="manual">
    <TabsList :aria-label="label" class="flex min-w-0 gap-0.5">
      <TabsTrigger v-for="t in tabs" :key="t.key" :value="t.key" as-child>
        <RouterLink
          :to="to(t.key)"
          class="-mb-px rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-2 text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-text"
        >
          {{ t.label }} <Chip v-if="t.count !== null" variant="tint" size="xs" class="ml-0.5 font-medium">{{ t.count }}</Chip>
        </RouterLink>
      </TabsTrigger>
    </TabsList>
  </TabsRoot>
</template>
