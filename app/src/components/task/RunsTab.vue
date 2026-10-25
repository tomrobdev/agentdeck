<script setup lang="ts">
import { computed } from 'vue';
import { type TaskDetail, ago, fmtTokens, runDuration, totalTokens } from '../../api';
import LogView from './LogView.vue';
import Markdown from '../files/Markdown.vue';
import FinalMessage from './FinalMessage.vue';

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
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <p v-if="!task.runs.length" class="text-muted">No runs yet. A run starts when the scheduler picks this task up.</p>
    <div v-else class="flex flex-none flex-col overflow-hidden rounded-md border border-border">
      <button
        v-for="r in [...task.runs].reverse()"
        :key="r.id"
        class="flex items-center gap-2.5 rounded-none border-0 border-b border-border px-3.5 py-2 text-left last:border-b-0 hover:border-muted"
        :class="[
          `s-${r.outcome ?? 'running'}`,
          r.id === chosen ? 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] shadow-[inset_2px_0_0_var(--accent)]' : 'bg-panel',
        ]"
        @click="emit('select', r.id)"
      >
        <span class="dot" />
        <span class="font-semibold" :title="r.kind === 'resolve' ? 'Merged the base branch into the branch; uses no attempt' : undefined">{{
          r.kind === 'resolve' ? 'Resolve conflicts' : `Run ${r.attempt}`
        }}</span>
        <span class="text-status">{{ r.outcome ?? 'running' }}</span>
        <span class="flex gap-2 text-sm">
          <span :class="r.tests_passed === null ? 'text-muted' : r.tests_passed ? 'text-done' : 'text-failed'">
            tests {{ r.tests_passed === null ? '–' : r.tests_passed ? '✓' : '✗' }}
          </span>
          <span v-if="r.denials" class="text-failed">{{ r.denials }} refused</span>
        </span>
        <span class="ml-auto text-sm text-muted">
          {{ runDuration(r) }}<template v-if="r.num_turns"> · {{ r.num_turns }} turns</template
          ><template v-if="totalTokens(r)"> · {{ fmtTokens(totalTokens(r)) }} tok</template> · {{ ago(r.started_at) }}
        </span>
      </button>
    </div>

    <FinalMessage v-if="run?.result_text" class="max-h-[40vh] flex-none overflow-y-auto" :open="run.outcome !== 'done'">
      <Markdown :text="run.result_text" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
    </FinalMessage>

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
