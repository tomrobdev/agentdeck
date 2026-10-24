<script setup lang="ts">
import { computed } from 'vue';
import { type Status, describeState, relTime } from '../api';
import { needYouCount } from '../taskView';
import { MODES, THEMES, type ThemeKey, mode, setMode, setTheme, theme } from '../theme';

const props = defineProps<{ status: Status | null; offline: boolean; busy: boolean }>();
defineEmits<{ toggle: []; newTask: []; repos: []; settings: [] }>();

const state = computed(() => describeState(props.status, props.offline));
const needYou = computed(() => needYouCount(props.status));

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
  <header class="flex items-center gap-3 border-b border-border bg-panel px-4 py-2.5">
    <div class="text-md font-[650] tracking-[-0.01em]">AgentDeck</div>
    <span class="pill" :class="state.cls" :title="state.title"><span class="dot" />{{ state.label }}</span>
    <span v-if="status && !offline" class="muted" :title="status.governor.reason ?? ''">
      {{ status.running }}/{{ status.governor.max_concurrent }} slots<template
        v-if="status.governor.max_concurrent < status.max_concurrent"
      >
        (throttled)</template
      >
    </span>

    <span v-if="needYou && !offline" class="muted" title="Proposals, blocked tasks and PRs waiting for review">{{ needYou }} need you</span>

    <div class="ml-2 flex gap-4" v-if="meters.length && !offline">
      <div
        v-for="m in meters"
        :key="m.label"
        class="flex items-center gap-1.5 tabular-nums"
        :title="`${m.pct}% used · ${m.markTitle} · resets in ${m.resets}`"
      >
        <span class="muted">{{ m.label }}</span>
        <div class="relative h-1.5 w-20 rounded-[3px] bg-panel-2">
          <div
            class="h-full rounded-[3px] transition-[width] duration-[400ms]"
            :style="{ width: m.pct + '%' }"
            :class="m.pct >= m.mark * 100 ? 'bg-blocked' : 'bg-running'"
          />
          <div
            class="absolute -top-[3px] -bottom-[3px] -ml-px w-0.5 rounded-[1px] bg-text opacity-55"
            :style="{ left: m.mark * 100 + '%' }"
          />
        </div>
        <span>{{ m.pct }}%</span>
        <span class="muted text-xs max-lg:hidden">↻ {{ m.resets }}</span>
      </div>
    </div>

    <div class="spacer" />
    <div class="flex items-center gap-1.5">
      <select
        class="w-auto px-1.5 py-0.5 text-sm"
        :value="theme"
        aria-label="Theme"
        title="Theme"
        @change="setTheme(($event.target as HTMLSelectElement).value as ThemeKey)"
      >
        <option v-for="t in THEMES" :key="t.key" :value="t.key">{{ t.label }}</option>
      </select>
      <div class="seg" role="group" aria-label="Mode">
        <button
          v-for="m in MODES"
          :key="m.key"
          type="button"
          :class="{ on: mode === m.key }"
          :aria-pressed="mode === m.key"
          :title="m.key === 'system' ? 'Follow the system light or dark setting' : `Always ${m.key}`"
          @click="setMode(m.key)"
        >
          {{ m.label }}
        </button>
      </div>
    </div>
    <button @click="$emit('settings')" :disabled="offline" title="Budget and notifications">Settings</button>
    <button @click="$emit('repos')" :disabled="offline">Repos</button>
    <button @click="$emit('toggle')" :disabled="offline || !status || busy">
      {{ status?.paused ? '▶ Resume' : '⏸ Pause' }}
    </button>
    <button class="primary" @click="$emit('newTask')" :disabled="offline">+ New task</button>
  </header>
</template>
