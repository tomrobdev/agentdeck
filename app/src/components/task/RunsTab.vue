<script setup lang="ts">
import { computed } from 'vue';
import { type TaskDetail, ago, fmtTokens, runDuration, totalTokens } from '../../api';
import LogView from '../LogView.vue';
import Markdown from '../files/Markdown.vue';

// The checks view: one card per run, then the chosen run's final message and log.
const props = defineProps<{ task: TaskDetail; runId: number | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ select: [runId: number]; path: [path: string, line: number | null] }>();

// Runs are picked by id: a resolve run shares its attempt number with a work run.
const latest = computed(() => props.task.runs.at(-1)?.id ?? null);
const chosen = computed(() => props.runId ?? latest.value);
const run = computed(() => props.task.runs.find((r) => r.id === chosen.value));
const live = computed(() => props.task.status === 'running' && chosen.value === latest.value);
</script>

<template>
  <div class="runs">
    <p v-if="!task.runs.length" class="muted">No runs yet. A run starts when the scheduler picks this task up.</p>
    <div v-else class="cards">
      <button
        v-for="r in [...task.runs].reverse()"
        :key="r.id"
        class="card"
        :class="[`s-${r.outcome ?? 'running'}`, { on: r.id === chosen }]"
        @click="emit('select', r.id)"
      >
        <span class="dot" />
        <span class="name" :title="r.kind === 'resolve' ? 'Merged the base branch into the branch; uses no attempt' : undefined">{{
          r.kind === 'resolve' ? 'Resolve conflicts' : `Run ${r.attempt}`
        }}</span>
        <span class="outcome">{{ r.outcome ?? 'running' }}</span>
        <span class="checks">
          <span :class="r.tests_passed === null ? 'muted' : r.tests_passed ? 'ok' : 'bad'">
            tests {{ r.tests_passed === null ? '–' : r.tests_passed ? '✓' : '✗' }}
          </span>
          <span v-if="r.denials" class="bad">{{ r.denials }} refused</span>
        </span>
        <span class="muted stats">
          {{ runDuration(r) }}<template v-if="r.num_turns"> · {{ r.num_turns }} turns</template
          ><template v-if="totalTokens(r)"> · {{ fmtTokens(totalTokens(r)) }} tok</template> · {{ ago(r.started_at) }}
        </span>
      </button>
    </div>

    <details v-if="run?.result_text" class="final" :open="run.outcome !== 'done'">
      <summary>Final message</summary>
      <Markdown :text="run.result_text" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
    </details>

    <LogView
      v-if="task.status !== 'proposed'"
      :task-id="task.id"
      :run-id="chosen"
      :live="live"
      :worktree="task.worktree"
      @file="(p) => emit('path', p, null)"
    />
  </div>
</template>

<style scoped>
.runs {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.cards {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  flex: none;
}
.card {
  display: flex;
  align-items: center;
  gap: 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: var(--panel);
  padding: 8px 14px;
  text-align: left;
}
.card:last-child {
  border-bottom: none;
}
.card.on {
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  box-shadow: inset 2px 0 0 var(--accent);
}
.name {
  font-weight: 600;
}
.outcome {
  color: var(--c);
}
.checks {
  display: flex;
  gap: 8px;
  font-size: 12px;
}
.stats {
  margin-left: auto;
  font-size: 12px;
}
.ok {
  color: var(--done);
}
.bad {
  color: var(--failed);
}
.final {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 8px 14px;
  flex: none;
  max-height: 40vh;
  overflow-y: auto;
}
.final summary {
  cursor: pointer;
  color: var(--muted);
}
.final[open] summary {
  margin-bottom: 8px;
}
</style>
