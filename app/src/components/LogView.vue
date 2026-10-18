<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { type LogEntry, api } from '../api';

const props = defineProps<{ taskId: number; attempt: number | null; live: boolean }>();

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
  if (!props.attempt) return;
  stick = true;
  streaming.value = true;
  source = new EventSource(api.logUrl(props.taskId, props.attempt));
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

// Reopen when the task or attempt changes, or when a finished run's task starts running again.
watch(() => [props.taskId, props.attempt], open, { immediate: true });
watch(
  () => props.live,
  (live) => {
    if (live && !streaming.value) open();
  },
);
onBeforeUnmount(close);
</script>

<template>
  <div class="log" ref="box" @scroll="onScroll">
    <p v-if="!attempt" class="muted pad">No runs yet. The log appears here when the task starts.</p>
    <p v-else-if="!entries.length" class="muted pad">{{ streaming ? 'Waiting for output…' : 'Empty log.' }}</p>
    <div v-for="(e, i) in entries" :key="i" class="entry" :class="`k-${e.kind}`">
      <template v-if="e.kind === 'text'">
        <div class="msg">{{ e.text }}</div>
      </template>
      <template v-else-if="e.kind === 'tool'">
        <code
          ><b>{{ e.name }}</b> {{ e.input }}</code
        >
      </template>
      <template v-else-if="e.kind === 'result'">
        <div class="sep">result: {{ e.subtype }} · {{ e.turns }} turns</div>
      </template>
      <template v-else-if="e.kind === 'setup'">
        <details :open="!e.passed">
          <summary :class="e.passed ? 'ok' : 'bad'">Setup {{ e.passed ? 'done' : 'failed' }}: {{ e.cmd }}</summary>
          <pre>{{ e.output }}</pre>
        </details>
      </template>
      <template v-else-if="e.kind === 'tests'">
        <details :open="!e.passed">
          <summary :class="e.passed ? 'ok' : 'bad'">Tests {{ e.passed ? 'passed' : 'failed' }}</summary>
          <pre>{{ e.output }}</pre>
        </details>
      </template>
      <template v-else>
        <code class="bad">{{ e.text }}</code>
      </template>
    </div>
    <p v-if="streaming && entries.length" class="muted live">● live</p>
  </div>
</template>

<style scoped>
.log {
  overflow-y: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 0;
  min-height: 0;
  flex: 1;
}
.pad {
  padding: 4px 14px;
}
.entry {
  padding: 3px 14px;
}
.msg {
  white-space: pre-wrap;
  padding: 4px 0;
}
.k-tool code {
  display: block;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-tool b {
  color: var(--running);
  font-weight: 600;
}
.sep {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
  color: var(--muted);
  font-size: 12px;
}
pre {
  white-space: pre-wrap;
  max-height: 260px;
  overflow: auto;
  margin: 6px 0;
}
.ok {
  color: var(--done);
}
.bad {
  color: var(--failed);
}
summary {
  cursor: pointer;
}
.live {
  padding: 4px 14px;
  color: var(--running);
  font-size: 12px;
}
</style>
