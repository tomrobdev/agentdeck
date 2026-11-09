<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../../api/client';
import { parseTime } from '../../api/format';
import type { LogEntry, Run } from '../../api/types';
import { useHotkeys } from '../../composables/shared/useHotkeys';
import { LOG_FILTERS, type LogFilter, failureKeys, failureStep, filterItems, parseLogFilter } from '../../lib/runs/log-filter';
import { type LiveSource, runHeader, timeline } from '../../lib/runs/run-live';
import { loadSetting, saveSetting } from '../../lib/shared/storage';
import SegmentedControl from '../ui/form/SegmentedControl.vue';
import { buildTranscript, cutRoot } from '../../lib/runs/transcript';
import LogItem from './LogItem.vue';
import RunHeader from './RunHeader.vue';
import RunTimeline from './RunTimeline.vue';
import { filesTouched, promptsOf, withoutPrompts } from '../../lib/runs/context';
import RunContext from './RunContext.vue';

const props = defineProps<{
  taskId: number;
  runId: number | null;
  live: boolean;
  /** The chosen run, for the header and the timeline. */
  run?: Run;
  /** Where its turns and tool come from while it is live. */
  source?: LiveSource | null;
  /** The repo's test command, to tell a test call from another command. */
  testCmd?: string | null;
  worktree?: string | null;
  isPath?: (p: string) => boolean;
}>();
const emit = defineEmits<{ file: [path: string]; path: [path: string, line: number | null] }>();

/** A tool's file as a repo path: inside the worktree, made relative; outside it, null (nothing to link to). */
function repoPath(file: string | undefined): string | null {
  if (!file) return null;
  if (!file.startsWith('/')) return file.replace(/^\.\//, '');
  const root = props.worktree ? props.worktree.replace(/\/$/, '') + '/' : null;
  return root && file.startsWith(root) ? file.slice(root.length) : null;
}

const cut = computed(() => (props.worktree ? cutRoot(props.worktree) : undefined));
const entries = ref<LogEntry[]>([]);
const streaming = ref(false);
const box = ref<HTMLElement | null>(null);
let source: EventSource | null = null;
/** Whether the view follows the log's end; false once the reader scrolls up. */
const following = ref(true);
// What the run was told shows above the transcript, not in it.
const items = computed(() => buildTranscript(withoutPrompts(entries.value)));
const prompts = computed(() => promptsOf(entries.value));
const touched = computed(() => filesTouched(entries.value));
const filter = ref<LogFilter>(parseLogFilter(loadSetting<string>('runLogFilter', 'all')));
watch(filter, (f) => saveSetting('runLogFilter', f));
// The header and the failure marks read the whole log; the filter only changes what the log lists.
const shown = computed(() => filterItems(items.value, filter.value, props.testCmd ?? null));
const failures = computed(() => failureKeys(items.value, props.testCmd ?? null));

/** Move to the next or previous failure row below or above the top of the log. */
async function stepFailure(dir: 1 | -1) {
  const el = box.value;
  if (!el) return;
  const rows = [...el.querySelectorAll<HTMLElement>('[data-failure]')];
  const top = el.getBoundingClientRect().top;
  const i = failureStep(
    rows.map((r) => r.getBoundingClientRect().top - top - 8),
    dir,
  );
  if (i < 0) return;
  following.value = false;
  await nextTick();
  el.scrollTo({ top: el.scrollTop + rows[i].getBoundingClientRect().top - top - 8 });
}
useHotkeys({
  ']': { label: 'Next failure', scope: 'log', run: () => stepFailure(1) },
  '[': { label: 'Previous failure', scope: 'log', run: () => stepFailure(-1) },
});
const first = computed(() => entries.value.find((e) => e.at)?.at);

async function jump() {
  following.value = true;
  await nextTick();
  box.value?.scrollTo({ top: box.value.scrollHeight });
}

/** The run whose header shows: one seen live. A finished run opened later has the run list's summary instead. */
const liveRunId = ref<number | null>(null);
watch(
  () => props.run,
  (r) => {
    if (r && !r.ended_at) liveRunId.value = r.id;
  },
  { immediate: true },
);
const now = ref(Date.now());
const ticker = setInterval(() => {
  if (props.run && !props.run.ended_at) now.value = Date.now();
}, 1000);
const header = computed(() =>
  props.run && liveRunId.value === props.run.id ? runHeader(props.run, props.source ?? null, items.value, now.value) : null,
);
// The strip's segments depend on the entries alone; only its end moves with the clock.
const marks = computed(() => timeline(entries.value, props.testCmd ?? null));
const strip = computed(() => {
  const r = props.run;
  if (!r) return null;
  const start = parseTime(r.started_at);
  return { start, end: r.ended_at ? parseTime(r.ended_at) : Math.max(now.value, start + 1) };
});

/** Scroll the log to the last row at or before a moment. */
async function scrollToMoment(at: string) {
  const el = box.value;
  if (!el) return;
  const target = Date.parse(at);
  let row: HTMLElement | null = null;
  for (const r of el.querySelectorAll<HTMLElement>('[data-at]')) {
    if (Date.parse(r.dataset.at!) > target) break;
    row = r;
  }
  row ??= el.querySelector<HTMLElement>('[data-at]');
  if (!row) return;
  following.value = false;
  await nextTick();
  el.scrollTo({ top: el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - 8 });
}

function setFollowing(on: boolean) {
  if (on) void jump();
  else following.value = false;
}

function close() {
  source?.close();
  source = null;
  streaming.value = false;
}

function open() {
  close();
  entries.value = [];
  if (!props.runId) return;
  following.value = true;
  streaming.value = true;
  source = new EventSource(api.logUrl(props.taskId, props.runId));
  source.onmessage = async (e) => {
    entries.value.push(...(JSON.parse(e.data) as LogEntry[]));
    if (following.value) {
      await nextTick();
      box.value?.scrollTo({ top: box.value.scrollHeight });
    }
  };
  source.addEventListener('end', close);
  source.onerror = close;
}

function onScroll() {
  const el = box.value;
  if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

// Reopen when the task or run changes, or when a finished run's task starts running again.
watch(() => [props.taskId, props.runId], open, { immediate: true });
watch(
  () => props.live,
  (live) => {
    if (live && !streaming.value) open();
  },
);
onBeforeUnmount(() => {
  close();
  clearInterval(ticker);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-code-bg">
    <RunHeader v-if="header" :header="header" :following="following" @follow="setFollowing" />
    <RunTimeline
      v-if="strip && marks.segments.length"
      :segments="marks.segments"
      :ticks="marks.ticks"
      :start="strip.start"
      :end="strip.end"
      @jump="scrollToMoment"
    />
    <div class="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
      <SegmentedControl v-model="filter" label="Filter the log" :options="LOG_FILTERS" />
      <span class="ml-auto flex items-center gap-1 text-sm text-muted">
        <button
          class="btn-ghost"
          :disabled="!failures.size"
          title="Previous failure ([)"
          aria-label="Previous failure"
          @click="stepFailure(-1)"
        >
          ↑ Previous failure
        </button>
        <button class="btn-ghost" :disabled="!failures.size" title="Next failure (])" aria-label="Next failure" @click="stepFailure(1)">
          ↓ Next failure
        </button>
      </span>
    </div>
    <div ref="box" class="min-h-0 flex-1 overflow-y-auto py-2" @scroll="onScroll">
      <RunContext v-if="runId" :prompts="prompts" :touched="touched" :repo-path="repoPath" @file="(p) => emit('file', p)" />
      <p v-if="!runId" class="px-3.5 py-1 text-muted">No runs yet. The log appears here when the task starts.</p>
      <p v-else-if="!items.length" class="px-3.5 py-1 text-muted">{{ streaming ? 'Waiting for output…' : 'Empty log.' }}</p>
      <p v-else-if="!shown.length" class="px-3.5 py-1 text-muted">Nothing in this log matches {{ filter }}.</p>
      <LogItem
        :items="shown"
        :failures="failures"
        :first="first"
        :live="streaming"
        :repo-path="repoPath"
        :is-path="isPath"
        :cut="cut"
        @file="(p) => emit('file', p)"
        @path="(p, l) => emit('path', p, l)"
      />
      <button
        v-if="streaming && !following"
        class="sticky bottom-2 mr-3 ml-auto block rounded-full border border-border bg-panel px-3 py-1 text-sm shadow"
        @click="jump"
      >
        Jump to live ↓
      </button>
    </div>
  </div>
</template>
