<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { type LogEntry, api } from '../../api';

const props = defineProps<{ taskId: number; runId: number | null; live: boolean; worktree?: string | null }>();
const emit = defineEmits<{ file: [path: string] }>();

/** A tool's file as a repo path: inside the worktree, made relative; outside it, null (nothing to link to). */
function repoPath(file: string | undefined): string | null {
  if (!file) return null;
  if (!file.startsWith('/')) return file.replace(/^\.\//, '');
  const root = props.worktree ? props.worktree.replace(/\/$/, '') + '/' : null;
  return root && file.startsWith(root) ? file.slice(root.length) : null;
}

const entries = ref<LogEntry[]>([]);
const streaming = ref(false);
const box = ref<HTMLElement | null>(null);
let source: EventSource | null = null;
let stick = true;

function close() {
  source?.close();
  source = null;
  streaming.value = false;
}

function open() {
  close();
  entries.value = [];
  if (!props.runId) return;
  stick = true;
  streaming.value = true;
  source = new EventSource(api.logUrl(props.taskId, props.runId));
  source.onmessage = async (e) => {
    entries.value.push(...(JSON.parse(e.data) as LogEntry[]));
    if (stick) {
      await nextTick();
      box.value?.scrollTo({ top: box.value.scrollHeight });
    }
  };
  source.addEventListener('end', close);
  source.onerror = close;
}

function onScroll() {
  const el = box.value;
  if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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
    <div v-for="(e, i) in entries" :key="i" class="px-3.5 py-[3px]">
      <template v-if="e.kind === 'text'">
        <div class="py-1 whitespace-pre-wrap">{{ e.text }}</div>
      </template>
      <template v-else-if="e.kind === 'tool'">
        <code class="block truncate text-muted"
          ><b class="font-semibold text-running">{{ e.name }}</b>
          <button
            v-if="repoPath(e.file)"
            class="btn-ghost mr-1 text-accent underline"
            :title="`Open ${repoPath(e.file)}`"
            @click="emit('file', repoPath(e.file)!)"
          >
            {{ repoPath(e.file) }}
          </button>
          {{ e.input }}</code
        >
      </template>
      <template v-else-if="e.kind === 'result'">
        <div class="mt-1.5 border-t border-dashed border-border pt-1.5 text-sm text-muted">
          result: {{ e.subtype }} · {{ e.turns }} turns
        </div>
      </template>
      <template v-else-if="e.kind === 'setup'">
        <details :open="!e.passed">
          <summary class="cursor-pointer" :class="e.passed ? 'text-done' : 'text-failed'">
            Setup {{ e.passed ? 'done' : 'failed' }}: {{ e.cmd }}
          </summary>
          <pre class="my-1.5 max-h-65 overflow-auto whitespace-pre-wrap">{{ e.output }}</pre>
        </details>
      </template>
      <template v-else-if="e.kind === 'tests'">
        <details :open="!e.passed">
          <summary class="cursor-pointer" :class="e.passed ? 'text-done' : 'text-failed'">
            Tests {{ e.passed ? 'passed' : 'failed' }}
          </summary>
          <pre class="my-1.5 max-h-65 overflow-auto whitespace-pre-wrap">{{ e.output }}</pre>
        </details>
      </template>
      <template v-else>
        <code class="text-failed">{{ e.text }}</code>
      </template>
    </div>
    <p v-if="streaming && entries.length" class="px-3.5 py-1 text-sm text-running">● live</p>
  </div>
</template>
