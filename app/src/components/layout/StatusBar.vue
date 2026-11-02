<script setup lang="ts">
// The status bar along the bottom of the window: the daemon's state (click to pause or resume), slots,
// and the usage windows. Actions and navigation are in the header (AppHeader.vue).
import { computed } from 'vue';
import { type Status, type TaskSummary, api, describeState, relTime } from '../../api';
import { useActivity } from '../../composables/useActivity';
import { type ActivityItem, KIND_LABEL } from '../../lib/activity';
import { useActions } from '../../composables/useActions';
import { openTask } from '../../router';
import Popover from '../ui/Popover.vue';

const props = defineProps<{ status: Status | null; tasks: TaskSummary[]; offline: boolean; busy: boolean }>();
defineEmits<{ toggle: []; daemon: [] }>();

// Everything under way, from the task list and status the window already reads.
const activity = useActivity(
  () => props.tasks,
  () => props.status,
);
const actions = useActions();
const open = (item: ActivityItem) => item.taskId !== null && openTask(item.taskId, item.tab);
const cancelMerge = (item: ActivityItem) => item.taskId !== null && actions.run(() => api.cancelMerge(item.taskId!));

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

const toggleTitle = computed(() => {
  const action = props.status?.paused ? 'Resume: let new tasks start' : 'Pause: no new tasks start';
  return state.value.title ? `${state.value.title} · ${action}` : action;
});
</script>

<template>
  <footer class="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-panel px-3 text-xs tabular-nums">
    <button
      class="pill !py-0 text-xs"
      :class="state.cls"
      :disabled="offline || busy || !status"
      :title="toggleTitle"
      :aria-label="status?.paused ? 'Resume' : 'Pause'"
      @click="$emit('toggle')"
    >
      <span class="dot" />{{ state.label }} <span aria-hidden="true">{{ status?.paused ? '▶' : '⏸' }}</span>
    </button>

    <span v-if="status && !offline" class="muted" :title="status.governor.reason ?? ''">
      {{ status.running }}/{{ status.governor.max_concurrent }} slots<template
        v-if="status.governor.max_concurrent < status.max_concurrent"
      >
        (throttled)</template
      >
    </span>

    <Popover v-if="!offline && activity.length" up>
      <template #trigger>
        <button class="pill !py-0 text-xs" title="What is under way" aria-label="Activity">
          <span class="inline-block size-2.5 flex-none animate-spin rounded-full border border-running border-t-transparent" />
          {{ activity.length }} active
        </button>
      </template>
      <ul class="m-0 flex min-w-[320px] max-w-[460px] list-none flex-col gap-0.5 p-0 text-xs">
        <li v-for="item in activity" :key="item.key" class="flex items-center gap-1 rounded hover:bg-panel-2">
          <button
            class="flex min-w-0 flex-1 flex-col gap-0.5 border-0 bg-transparent px-2 py-1 text-left"
            :disabled="item.taskId === null"
            @click="open(item)"
          >
            <span class="truncate">
              <span class="muted">{{ KIND_LABEL[item.kind] }}</span>
              <template v-if="item.taskId !== null"> #{{ item.taskId }}</template>
              {{ item.title }}
            </span>
            <span class="muted truncate"
              >{{ item.doing }}<template v-if="item.took"> · for {{ item.took }}</template></span
            >
          </button>
          <button v-if="item.cancellable" class="mr-1 !py-0 text-xs" :disabled="busy" @click="cancelMerge(item)">Cancel merge</button>
        </li>
      </ul>
    </Popover>

    <template v-if="!offline">
      <span
        v-for="m in meters"
        :key="m.label"
        class="flex items-center gap-1.5"
        :title="`${m.pct}% used · ${m.markTitle} · resets in ${m.resets}`"
      >
        <span class="muted">{{ m.label }}</span>
        <span class="meter relative inline-block h-1 w-14 rounded-sm bg-panel-2">
          <span
            class="meter absolute inset-y-0 left-0 rounded-sm transition-[width] duration-[400ms]"
            :class="m.pct >= m.mark * 100 ? 'bg-blocked' : 'bg-running'"
            :style="{ width: m.pct + '%' }"
          />
          <span class="absolute -top-0.5 -bottom-0.5 -ml-px w-0.5 rounded-[1px] bg-text opacity-55" :style="{ left: m.mark * 100 + '%' }" />
        </span>
        <span :class="{ 'text-blocked': m.pct >= m.mark * 100 }">{{ m.pct }}%</span>
        <span class="muted max-lg:hidden">↻ {{ m.resets }}</span>
      </span>
    </template>

    <div class="spacer" />
    <span v-if="status && !offline && !status.governor.allow && status.governor.reason" class="muted truncate">
      On hold: {{ status.governor.reason }}
    </span>
    <button class="pill !py-0 text-xs" title="The daemon's health, and restart" @click="$emit('daemon')">Daemon</button>
  </footer>
</template>
