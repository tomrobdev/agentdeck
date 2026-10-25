<script setup lang="ts">
// The top bar: where to go and what to add. The daemon's live numbers are in the status bar at the bottom.
import { computed } from 'vue';
import type { Status } from '../api';
import { go, route } from '../router';
import { NEED_YOU_STATES, needYouCount } from '../taskView';

const props = defineProps<{ status: Status | null; offline: boolean }>();
defineEmits<{ newTask: []; repos: []; settings: [] }>();

const needYou = computed(() => needYouCount(props.status));
</script>

<template>
  <header class="flex items-center gap-1 border-b border-border bg-panel px-4 py-2">
    <div class="mr-4 text-md font-[650] tracking-[-0.01em]">AgentDeck</div>
    <nav class="flex gap-1" aria-label="Main">
      <button class="nav" :class="{ on: route.current.name === 'queue' }" @click="go({ name: 'queue' })">Queue</button>
      <button class="nav" :disabled="offline" @click="$emit('repos')">Repos</button>
      <button class="nav" :disabled="offline" title="Budget, notifications and appearance" @click="$emit('settings')">Settings</button>
    </nav>
    <div class="spacer" />
    <button
      v-if="needYou && !offline"
      class="nav mr-2"
      title="Proposals, blocked tasks and PRs waiting for review"
      @click="go({ name: 'queue', states: NEED_YOU_STATES })"
    >
      <span class="rounded-full bg-accent px-1.5 text-xs text-accent-fg">{{ needYou }}</span> need you
    </button>
    <button class="primary" :disabled="offline" @click="$emit('newTask')">+ New task</button>
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
