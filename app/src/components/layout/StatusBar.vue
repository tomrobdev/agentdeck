<script setup lang="ts">
// The status bar along the bottom of the window: the daemon's state (click to pause or resume), slots,
// and the usage windows. Actions and navigation are in the header (AppHeader.vue).
import { computed } from 'vue';
import { type Status, type TaskSummary, api, describeState, relTime } from '../../api';
import { useActivity } from '../../composables/useActivity';
import { type ActivityItem, KIND_LABEL } from '../../lib/activity';
import { useAction } from '../../composables/useActions';
import { openTask } from '../../router';
import Chip from '../ui/Chip.vue';
import Popover from '../ui/Popover.vue';
import Progress from '../ui/Progress.vue';
import Tooltip from '../ui/Tooltip.vue';

const props = defineProps<{ status: Status | null; tasks: TaskSummary[]; offline: boolean; busy: boolean }>();
defineEmits<{ toggle: []; daemon: [] }>();

// Everything under way, from the task list and status the window already reads.
const activity = useActivity(
  () => props.tasks,
  () => props.status,
);
const { pending: cancelling, run } = useAction();
const open = (item: ActivityItem) => item.taskId !== null && openTask(item.taskId, item.tab);
const cancelMerge = (item: ActivityItem) => item.taskId !== null && run(() => api.cancelMergeRequest(item.taskId!));

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
    <Chip
      as="button"
      :status="state.cls.slice(2)"
      variant="tint"
      size="xs"
      dot
      :disabled="offline || busy || !status"
      :title="toggleTitle"
      :aria-label="status?.paused ? 'Resume' : 'Pause'"
      :aria-pressed="!!status?.paused"
      @click="$emit('toggle')"
    >
      {{ state.label }} <span aria-hidden="true">{{ status?.paused ? '▶' : '⏸' }}</span>
    </Chip>

    <span v-if="status && !offline" class="text-muted" :title="status.governor.reason ?? ''">
      {{ status.running }}/{{ status.governor.max_concurrent }} slots<template
        v-if="status.governor.max_concurrent < status.max_concurrent"
      >
        (throttled)</template
      >
    </span>

    <Popover v-if="!offline && activity.length" up>
      <template #trigger>
        <Chip as="button" variant="tint" size="xs" title="What is under way" aria-label="Activity">
          <span class="inline-block size-2.5 flex-none animate-spin rounded-full border border-running border-t-transparent" />
          {{ activity.length }} active
        </Chip>
      </template>
      <template #default="{ close }">
        <ul class="m-0 flex min-w-[320px] max-w-[460px] list-none flex-col gap-0.5 p-0 text-xs">
          <li v-for="item in activity" :key="item.key" class="flex items-center gap-1 rounded hover:bg-panel-2">
            <button
              class="flex min-w-0 flex-1 flex-col gap-0.5 border-0 bg-transparent px-2 py-1 text-left"
              :disabled="item.taskId === null"
              @click="(open(item), close())"
            >
              <span class="truncate">
                <span class="text-muted">{{ KIND_LABEL[item.kind] }}</span>
                <template v-if="item.taskId !== null"> #{{ item.taskId }}</template>
                {{ item.title }}
              </span>
              <span class="text-muted truncate"
                >{{ item.doing }}<template v-if="item.took"> · for {{ item.took }}</template></span
              >
            </button>
            <button v-if="item.cancellable" class="mr-1 !py-0 text-xs" :disabled="cancelling" @click="cancelMerge(item)">
              Cancel merge
            </button>
          </li>
        </ul>
      </template>
    </Popover>

    <template v-if="!offline">
      <Tooltip v-for="m in meters" :key="m.label" :text="`${m.pct}% used\n${m.markTitle}\nresets in ${m.resets}`">
        <span class="flex items-center gap-1.5" tabindex="0">
          <span class="text-muted">{{ m.label }}</span>
          <Progress
            :label="`${m.label} usage`"
            :value="m.pct"
            class="meter relative inline-block h-1 w-14 rounded-sm bg-panel-2"
            :indicator-class="`meter absolute inset-y-0 left-0 rounded-sm transition-[width] duration-[400ms] ${m.pct >= m.mark * 100 ? 'bg-blocked' : 'bg-running'}`"
          >
            <span
              class="absolute -top-0.5 -bottom-0.5 -ml-px w-0.5 rounded-[1px] bg-text opacity-55"
              :style="{ left: m.mark * 100 + '%' }"
            />
          </Progress>
          <span :class="{ 'text-blocked': m.pct >= m.mark * 100 }">{{ m.pct }}%</span>
          <span class="text-muted max-lg:hidden">↻ {{ m.resets }}</span>
        </span>
      </Tooltip>
    </template>

    <div class="spacer" />
    <span v-if="status && !offline && !status.governor.allow && status.governor.reason" class="text-muted truncate">
      On hold: {{ status.governor.reason }}
    </span>
    <Chip as="button" variant="tint" size="xs" title="The daemon's health, and restart" @click="$emit('daemon')">Daemon</Chip>
  </footer>
</template>
