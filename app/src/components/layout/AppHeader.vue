<script setup lang="ts">
import { computed } from 'vue';
import type { Status } from '../../api/types';
import { RouterLink } from 'vue-router';
import { openPanel } from '../../composables/shared/useShell';
import { NEED_YOU_STATES, needYouCount } from '../../lib/work/task-view';
import BrandMark from '../ui/BrandMark.vue';
import Chip from '../ui/Chip.vue';

const props = defineProps<{ status: Status | null; offline: boolean }>();

const needYou = computed(() => needYouCount(props.status));
</script>

<template>
  <header class="flex items-center gap-1 border-b border-border bg-panel px-4 py-2">
    <div class="mr-4 flex items-center gap-1.5 text-md font-[650] tracking-[-0.01em]"><BrandMark /><span>agentdeck</span></div>
    <nav class="flex gap-1" aria-label="Main">
      <RouterLink class="nav" active-class="on" :to="{ name: 'queue' }">Queue</RouterLink>
      <button v-if="offline" class="nav" disabled title="The pilot scorecard over time">Insights</button>
      <RouterLink v-else class="nav" active-class="on" :to="{ name: 'insights' }" title="The pilot scorecard over time"
        >Insights</RouterLink
      >
      <button class="nav" :disabled="offline" @click="openPanel('repos')">Repos</button>
      <button class="nav" :disabled="offline" title="Budget, notifications and appearance" @click="openPanel('settings')">Settings</button>
    </nav>
    <div class="spacer" />
    <RouterLink
      v-if="needYou && !offline"
      class="nav mr-2"
      title="Proposals, blocked tasks and PRs waiting for review"
      :to="{ name: 'queue', query: { states: NEED_YOU_STATES.join(',') } }"
    >
      <Chip tone="accent" variant="solid" size="xs">{{ needYou }}</Chip> need you
    </RouterLink>
    <button class="primary" :disabled="offline" @click="openPanel('new')">+ New task</button>
  </header>
</template>

<style scoped>
.nav {
  display: inline-block;
  border: 1px solid transparent;
  border-radius: var(--r-ctl, 6px);
  background: transparent;
  padding: 4px 10px;
  white-space: nowrap;
}
a.nav:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.nav:hover:not(:disabled),
.nav.on {
  background: var(--panel-2);
}
.nav.on {
  font-weight: 600;
}
</style>
