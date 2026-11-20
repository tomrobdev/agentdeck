<script setup lang="ts">
import { computed } from 'vue';
import { landingApi } from '#api/landing.ts';
import { describeState } from '#lib/operations/daemon-wording.ts';
import { relTime } from '#lib/shared/time.ts';
import type { Status, TaskSummary } from '#api/types.ts';
import { useActivity } from '#composables/operations/useActivity.ts';
import { type ActivityItem, KIND_LABEL } from '#lib/operations/activity.ts';
import { useAction } from '#composables/shared/useActions.ts';
import { useRouter } from 'vue-router';
import { openPanel } from '#composables/shared/useShell.ts';
import Chip from '#components/ui/Chip.vue';
import Popover from '#components/ui/Popover.vue';
import Progress from '#components/ui/status/Progress.vue';
import Tooltip from '#components/ui/Tooltip.vue';

const props = defineProps<{ status: Status | null; tasks: TaskSummary[]; offline: boolean; busy: boolean }>();
defineEmits<{ toggle: [] }>();

const activity = useActivity(
  () => props.tasks,
  () => props.status,
);
const { pending: cancelling, run } = useAction();
const router = useRouter();
const open = (item: ActivityItem) => item.taskId !== null && router.push({ name: 'task', params: { id: item.taskId, tab: item.tab } });
const cancelMerge = (item: ActivityItem) => {
  const id = item.taskId;
  return id !== null && run(() => landingApi.cancelMergeRequest(id));
};

const state = computed(() => describeState(props.status, props.offline));

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

const reviewDue = computed(() => {
  const due = props.offline ? [] : (props.status?.headline.review_due ?? []);
  if (!due.length) return null;
  const title = due.map((r) => `${r.repo}: ${r.line}`).join('\n');
  return { label: due.length === 1 ? `${due[0].repo}: ${due[0].line}` : `area review due in ${due.length} repos`, title };
});

const planConflicts = computed(() => {
  const found = props.offline ? [] : (props.status?.headline.plan_branches ?? []);
  if (!found.length) return null;
  const title = found.map((b) => `${b.repo}: ${b.line}`).join('\n');
  return { label: found.length === 1 ? `${found[0].name} conflicts with its base` : `${found.length} plan branches conflict`, title };
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
      {{ status.headline.slots ?? `${status.running}/${status.governor.max_concurrent} slots`
      }}<template v-if="status.governor.max_concurrent < status.max_concurrent"> (throttled)</template>
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
    <span v-if="reviewDue" class="truncate text-blocked" :title="reviewDue.title">{{ reviewDue.label }}</span>
    <span v-if="planConflicts" class="truncate text-blocked" :title="planConflicts.title">{{ planConflicts.label }}</span>
    <Chip as="button" variant="tint" size="xs" title="The daemon's health, and restart" @click="openPanel('daemon')">Daemon</Chip>
  </footer>
</template>
