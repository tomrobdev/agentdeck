<script setup lang="ts">
import { computed } from 'vue';
import type { Status } from '../../api/types';
import { go, route } from '../../router';
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
      <button class="nav" :class="{ on: route.current.name === 'queue' }" @click="go({ name: 'queue' })">Queue</button>
      <button
        class="nav"
        :class="{ on: route.current.name === 'insights' }"
        :disabled="offline"
        title="The pilot scorecard over time"
        @click="go({ name: 'insights' })"
      >
        Insights
      </button>
      <button class="nav" :disabled="offline" @click="openPanel('repos')">Repos</button>
      <button class="nav" :disabled="offline" title="Budget, notifications and appearance" @click="openPanel('settings')">Settings</button>
    </nav>
    <div class="spacer" />
    <button
      v-if="needYou && !offline"
      class="nav mr-2"
      title="Proposals, blocked tasks and PRs waiting for review"
      @click="go({ name: 'queue', states: NEED_YOU_STATES })"
    >
      <Chip tone="accent" variant="solid" size="xs">{{ needYou }}</Chip> need you
    </button>
    <button class="primary" :disabled="offline" @click="openPanel('new')">+ New task</button>
  </header>
</template>

<style scoped>
.nav {
  border-color: transparent;
  background: transparent;
}
.nav:hover:not(:disabled),
.nav.on {
  background: var(--panel-2);
}
.nav.on {
  font-weight: 600;
}
</style>
