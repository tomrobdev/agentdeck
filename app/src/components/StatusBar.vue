<script setup lang="ts">
import { computed } from 'vue';
import { type Status, relTime } from '../api';

const props = defineProps<{ status: Status | null; offline: boolean; busy: boolean }>();
defineEmits<{ toggle: []; newTask: []; repos: [] }>();

const limited = computed(() => {
  const until = props.status?.rate_limited_until;
  return until && until * 1000 > Date.now() ? until : null;
});

const state = computed(() => {
  if (props.offline) return { label: 'Daemon offline', cls: 's-failed' };
  if (!props.status) return { label: 'Connecting…', cls: 's-queued' };
  if (props.status.paused) return { label: 'Paused', cls: 's-blocked' };
  if (limited.value) return { label: `Rate limited · ${relTime(limited.value)}`, cls: 's-blocked' };
  return { label: props.status.running ? 'Working' : 'Idle', cls: props.status.running ? 's-running' : 's-done' };
});

const windows = computed(() =>
  (props.status?.usage ?? []).map((w) => ({
    label: w.window === 'five_hour' ? '5h' : w.window === 'seven_day' ? '7d' : w.window,
    pct: Math.round(w.utilization * 100),
    resets: relTime(w.resets_at),
  })),
);
</script>

<template>
  <header class="bar">
    <div class="brand">AgentDeck</div>
    <span class="pill" :class="state.cls"><span class="dot" />{{ state.label }}</span>
    <span v-if="status && !offline" class="muted">{{ status.running }}/{{ status.max_concurrent }} slots</span>

    <div class="usage" v-if="windows.length && !offline">
      <div v-for="w in windows" :key="w.label" class="meter" :title="`${w.pct}% used, resets in ${w.resets}`">
        <span class="muted">{{ w.label }}</span>
        <div class="track"><div class="fill" :style="{ width: w.pct + '%' }" :class="{ hot: w.pct >= 80 }" /></div>
        <span>{{ w.pct }}%</span>
        <span class="muted reset">↻ {{ w.resets }}</span>
      </div>
    </div>

    <div class="spacer" />
    <button @click="$emit('repos')" :disabled="offline">Repos</button>
    <button @click="$emit('toggle')" :disabled="offline || !status || busy">
      {{ status?.paused ? '▶ Resume' : '⏸ Pause' }}
    </button>
    <button class="primary" @click="$emit('newTask')" :disabled="offline">+ New task</button>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.brand {
  font-weight: 650;
  letter-spacing: -0.01em;
  font-size: 14px;
}
.usage {
  display: flex;
  gap: 16px;
  margin-left: 8px;
}
.meter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.track {
  width: 80px;
  height: 6px;
  border-radius: 3px;
  background: var(--panel-2);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--running);
  transition: width 0.4s;
}
.fill.hot {
  background: var(--failed);
}
.reset {
  font-size: 11px;
}
.spacer {
  flex: 1;
}
@media (max-width: 1000px) {
  .reset {
    display: none;
  }
}
</style>
