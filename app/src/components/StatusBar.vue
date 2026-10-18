<script setup lang="ts">
import { computed } from 'vue';
import { type Status, describeState, relTime } from '../api';

const props = defineProps<{ status: Status | null; offline: boolean; busy: boolean }>();
defineEmits<{ toggle: []; newTask: []; repos: []; settings: [] }>();

const state = computed(() => describeState(props.status, props.offline));

/** Meters with a marker for the budget line that matters for each window. */
const meters = computed(() => {
  const s = props.status;
  if (!s) return [];
  return s.usage.map((w) => {
    const pct = Math.round(w.utilization * 100);
    if (w.window === 'five_hour') {
      return {
        label: '5h',
        pct,
        resets: relTime(w.resets_at),
        mark: s.budget.five_hour_max,
        markTitle: `cap ${Math.round(s.budget.five_hour_max * 100)}%`,
      };
    }
    const allowed = s.governor.weekly_allowed ?? s.budget.weekly_max;
    return { label: '7d', pct, resets: relTime(w.resets_at), mark: allowed, markTitle: `on pace up to ${Math.round(allowed * 100)}% now` };
  });
});
</script>

<template>
  <header class="bar">
    <div class="brand">AgentDeck</div>
    <span class="pill" :class="state.cls" :title="state.title"><span class="dot" />{{ state.label }}</span>
    <span v-if="status && !offline" class="muted" :title="status.governor.reason ?? ''">
      {{ status.running }}/{{ status.governor.max_concurrent }} slots<template
        v-if="status.governor.max_concurrent < status.max_concurrent"
      >
        (throttled)</template
      >
    </span>

    <div class="usage" v-if="meters.length && !offline">
      <div v-for="m in meters" :key="m.label" class="meter" :title="`${m.pct}% used · ${m.markTitle} · resets in ${m.resets}`">
        <span class="muted">{{ m.label }}</span>
        <div class="track">
          <div class="fill" :style="{ width: m.pct + '%' }" :class="{ hot: m.pct >= m.mark * 100 }" />
          <div class="mark" :style="{ left: m.mark * 100 + '%' }" />
        </div>
        <span>{{ m.pct }}%</span>
        <span class="muted reset">↻ {{ m.resets }}</span>
      </div>
    </div>

    <div class="spacer" />
    <button @click="$emit('settings')" :disabled="offline" title="Budget and notifications">Settings</button>
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
  position: relative;
  width: 80px;
  height: 6px;
  border-radius: 3px;
  background: var(--panel-2);
}
.fill {
  height: 100%;
  border-radius: 3px;
  background: var(--running);
  transition: width 0.4s;
}
.fill.hot {
  background: var(--blocked);
}
.mark {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  background: var(--text);
  opacity: 0.55;
  border-radius: 1px;
}
.reset {
  font-size: 11px;
}
.spacer {
  flex: 1;
}
@media (max-width: 1080px) {
  .reset {
    display: none;
  }
}
</style>
