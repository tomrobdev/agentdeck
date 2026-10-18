<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { type TaskDetail, ago, fmtTokens, totalTokens } from '../api';
import LogView from './LogView.vue';

const props = defineProps<{ task: TaskDetail }>();
defineEmits<{ cancel: []; retry: [] }>();

const attempt = ref<number | null>(null);
const showPrompt = ref(false);
const copied = ref('');

const latest = computed(() => props.task.runs.at(-1)?.attempt ?? null);
// Follow the newest attempt unless the user picked an older one.
watch(
  () => props.task.id,
  () => (attempt.value = latest.value),
  { immediate: true },
);
watch(latest, (now, before) => {
  if (attempt.value === null || attempt.value === before) attempt.value = now;
});

const run = computed(() => props.task.runs.find((r) => r.attempt === attempt.value));
const live = computed(() => props.task.status === 'running' && attempt.value === latest.value);
const canCancel = computed(() => ['queued', 'running', 'blocked', 'failed'].includes(props.task.status));
const canRetry = computed(() => ['blocked', 'failed', 'cancelled', 'done'].includes(props.task.status));
const statusLabel = computed(() => (props.task.status === 'cancel_requested' ? 'stopping' : props.task.status));

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  copied.value = what;
  setTimeout(() => (copied.value = ''), 1200);
}
</script>

<template>
  <section class="detail">
    <div class="head">
      <div>
        <h2>{{ task.title }}</h2>
        <div class="muted">#{{ task.id }} · {{ task.repo }} · {{ task.model }} · created {{ ago(task.created_at) }}</div>
      </div>
      <span class="pill" :class="`s-${task.status}`"><span class="dot" />{{ statusLabel }}</span>
      <div class="spacer" />
      <button v-if="canRetry" @click="$emit('retry')">↻ Retry</button>
      <button v-if="canCancel" @click="$emit('cancel')">{{ task.status === 'running' ? '■ Stop' : '✕ Cancel' }}</button>
    </div>

    <div v-if="task.blocked_reason && (task.status === 'blocked' || task.status === 'failed')" class="callout" :class="`s-${task.status}`">
      {{ task.blocked_reason }}
    </div>

    <dl class="facts">
      <dt>Attempts</dt>
      <dd>{{ task.attempts }} / {{ task.max_attempts }} · max {{ task.max_turns }} turns · priority {{ task.priority }}</dd>
      <template v-if="task.branch">
        <dt>Branch</dt>
        <dd>
          <code>{{ task.branch }}</code>
          <button class="link" @click="copy(task.branch, 'branch')">{{ copied === 'branch' ? 'copied' : 'copy' }}</button>
        </dd>
      </template>
      <template v-if="task.worktree">
        <dt>Worktree</dt>
        <dd>
          <code>{{ task.worktree }}</code>
          <button class="link" @click="copy(task.worktree, 'wt')">{{ copied === 'wt' ? 'copied' : 'copy' }}</button>
        </dd>
      </template>
      <dt>Prompt</dt>
      <dd>
        <div class="prompt" :class="{ clamp: !showPrompt }" @click="showPrompt = !showPrompt">{{ task.prompt }}</div>
      </dd>
    </dl>

    <div v-if="task.runs.length" class="runs">
      <button
        v-for="r in task.runs"
        :key="r.id"
        class="run"
        :class="[`s-${r.outcome ?? 'running'}`, { on: r.attempt === attempt }]"
        @click="attempt = r.attempt"
      >
        <span class="dot" />
        Run {{ r.attempt }} · {{ r.outcome ?? 'running' }}
        <span class="muted">
          <template v-if="r.num_turns"> · {{ r.num_turns }} turns</template>
          <template v-if="totalTokens(r)"> · {{ fmtTokens(totalTokens(r)) }} tok</template>
          <template v-if="r.tests_passed !== null"> · tests {{ r.tests_passed ? '✓' : '✗' }}</template>
        </span>
      </button>
    </div>

    <details v-if="run?.result_text" class="final" :open="run.outcome !== 'done'">
      <summary>Final message</summary>
      <div class="text">{{ run.result_text }}</div>
    </details>

    <LogView :task-id="task.id" :attempt="attempt" :live="live" />
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  min-height: 0;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
h2 {
  margin: 0 0 2px;
  font-size: 16px;
  font-weight: 650;
}
.spacer {
  flex: 1;
}
.callout {
  padding: 8px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--c) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
}
.facts {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 6px 12px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
dd code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
}
.prompt {
  white-space: pre-wrap;
  cursor: pointer;
}
.prompt.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.runs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.run {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.run.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--panel));
}
.s-rate_limited {
  --c: var(--blocked);
}
.final {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  max-height: 180px;
  overflow: auto;
  flex: none;
}
.final summary {
  cursor: pointer;
  color: var(--muted);
}
.final .text {
  white-space: pre-wrap;
  margin-top: 6px;
}
</style>
