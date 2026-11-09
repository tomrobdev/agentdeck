<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { MODEL_LABELS, type TaskDetail, ago, reposQuery, runDuration, runHint, runLabel } from '../../../api';
import { liveSource } from '../../../lib/runs/run-live';
import { RUN_KIND_ICONS, runCost } from '../../../lib/runs/run-row';
import Progress from '../../ui/status/Progress.vue';
import LogView from './LogView.vue';
import Markdown from '../../files/Markdown.vue';
import FinalMessage from './FinalMessage.vue';
import RunSummaryCard from './RunSummaryCard.vue';
import VerifyFindings from '../overview/VerifyFindings.vue';
import { latestVerify } from '../../../../../daemon/src/domain/runs/index.ts';
import Listbox from '../../ui/form/Listbox.vue';

// The checks view: one card per run, then the chosen run's final message and log.
const props = defineProps<{ task: TaskDetail; runId: number | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ select: [runId: number]; path: [path: string, line: number | null] }>();

// Runs are picked by id: a resolve run shares its attempt number with a work run.
const latest = computed(() => props.task.runs.at(-1)?.id ?? null);
const chosen = computed(() => props.runId ?? latest.value);
const run = computed(() => props.task.runs.find((r) => r.id === chosen.value));
const reposQ = useQuery(reposQuery());
const testCmd = computed(() => reposQ.data.value?.find((r) => r.id === props.task.repo_id)?.test_cmd ?? null);
const source = computed(() => (run.value && !run.value.ended_at ? liveSource(run.value, props.task) : null));
const live = computed(() => (props.task.status === 'running' || !!props.task.sync?.resolving) && chosen.value === latest.value);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <p v-if="!task.runs.length" class="text-muted">No runs yet. A run starts when the scheduler picks this task up.</p>
    <Listbox
      v-else
      class="flex-none overflow-hidden rounded-md border border-border"
      label="Runs"
      item-class="border-b border-border last:border-b-0"
      :options="[...task.runs].reverse().map((r) => ({ value: r.id, run: r }))"
      :model-value="chosen!"
      @update:model-value="(id) => emit('select', id)"
    >
      <template #default="{ option: { run: r }, selected }">
        <div
          class="flex items-center gap-2.5 px-3.5 py-2 text-left"
          :class="[
            `s-${r.outcome ?? 'running'}`,
            selected ? 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] shadow-[inset_2px_0_0_var(--accent)]' : 'bg-panel',
          ]"
        >
          <span class="dot" />
          <span class="font-semibold" :title="runHint(r)">{{ runLabel(r) }}</span>
          <span
            class="text-status"
            :title="
              r.outcome === 'interrupted'
                ? 'A daemon restart stopped this run; the next run continues it without using an attempt'
                : undefined
            "
            >{{ r.outcome ?? 'running' }}</span
          >
          <span class="flex gap-2 text-sm">
            <span :class="r.tests_passed === null ? 'text-muted' : r.tests_passed ? 'text-done' : 'text-failed'">
              tests {{ r.tests_passed === null ? '–' : r.tests_passed ? '✓' : '✗' }}
            </span>
            <span v-if="r.denials" class="text-blocked">{{ r.denials }} refused</span>
          </span>
          <Progress
            v-if="!r.ended_at && liveSource(r, task)?.max_turns"
            class="h-1 w-16 flex-none overflow-hidden rounded-full bg-border"
            indicator-class="bg-running"
            label="Turns used"
            :value="liveSource(r, task)!.turns"
            :max="liveSource(r, task)!.max_turns"
          />
          <span class="ml-auto text-sm text-muted">
            <span :title="RUN_KIND_ICONS[r.kind].label" :aria-label="RUN_KIND_ICONS[r.kind].label">{{ RUN_KIND_ICONS[r.kind].icon }}</span>
            <template v-if="r.model"
              >&nbsp;<span :title="r.model_id ?? ''">{{ MODEL_LABELS[r.model] ?? r.model }}</span></template
            >
            · {{ runDuration(r) }}<template v-if="r.num_turns"> · {{ r.num_turns }} turns</template> ·
            <span class="tabular-nums" :title="runCost(r).title">{{ runCost(r).text }}</span> · {{ ago(r.started_at) }}
          </span>
        </div>
        <p
          v-if="r.summary"
          class="truncate px-3.5 pb-2 pl-8 text-left text-sm text-muted"
          :class="selected ? 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))]' : 'bg-panel'"
          :title="r.summary.verdict"
        >
          {{ r.summary.verdict }}
        </p>
      </template>
    </Listbox>

    <RunSummaryCard v-if="run?.summary" :key="`summary-${run.id}`" class="flex-none" :summary="run.summary" />

    <!-- A verify run's result is its findings as JSON, shown as findings, not as a message. -->
    <VerifyFindings
      v-if="run?.kind === 'verify' && run.ended_at"
      :key="`verify-${run.id}`"
      class="max-h-[40vh] flex-none overflow-y-auto rounded-md border border-border bg-panel px-3.5 py-2"
      :view="latestVerify([run], null)!"
      @path="(p, l) => emit('path', p, l)"
    />
    <FinalMessage v-else-if="run?.result_text" :key="run.id" class="max-h-[40vh] flex-none overflow-y-auto" :open="run.outcome !== 'done'">
      <Markdown :text="run.result_text" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
    </FinalMessage>

    <LogView
      v-if="task.status !== 'proposed' || run?.kind === 'verify'"
      :task-id="task.id"
      :run-id="chosen"
      :live="live"
      :run="run"
      :source="source"
      :test-cmd="testCmd"
      :worktree="task.worktree"
      :is-path="isPath"
      @file="(p) => emit('path', p, null)"
      @path="(p, l) => emit('path', p, l)"
    />
  </div>
</template>
