<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { type LogEntry, api } from '../../api';
import { buildTranscript, cutRoot } from '../../lib/transcript';
import LogItem from './LogItem.vue';

const props = defineProps<{
  taskId: number;
  runId: number | null;
  live: boolean;
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
const items = computed(() => buildTranscript(entries.value));
const first = computed(() => entries.value.find((e) => e.at)?.at);

async function jump() {
  following.value = true;
  await nextTick();
  box.value?.scrollTo({ top: box.value.scrollHeight });
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
onBeforeUnmount(close);
</script>

<template>
  <div ref="box" class="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-code-bg py-2" @scroll="onScroll">
    <p v-if="!runId" class="px-3.5 py-1 text-muted">No runs yet. The log appears here when the task starts.</p>
    <p v-else-if="!entries.length" class="px-3.5 py-1 text-muted">{{ streaming ? 'Waiting for output…' : 'Empty log.' }}</p>
    <LogItem
      :items="items"
      :first="first"
      :live="streaming"
      :repo-path="repoPath"
      :is-path="isPath"
      :cut="cut"
      @file="(p) => emit('file', p)"
      @path="(p, l) => emit('path', p, l)"
    />
    <p v-if="streaming && entries.length" class="px-3.5 py-1 text-sm text-running">● live</p>
    <button
      v-if="streaming && !following"
      class="sticky bottom-2 mr-3 ml-auto block rounded-full border border-border bg-panel px-3 py-1 text-sm shadow"
      @click="jump"
    >
      Jump to live ↓
    </button>
  </div>
</template>
