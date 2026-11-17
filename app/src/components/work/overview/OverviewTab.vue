<script setup lang="ts">
import { computed, ref } from 'vue';
import { type PersonEventText, describeEvent } from '#daemon/domain/work/index.ts';
import { fmtTokens, runLabel, totalTokens } from '#lib/runs/run-wording.ts';
import { ago, runDuration } from '#lib/shared/time.ts';
import type { Changes, Run, TaskDetail, TaskEventRow } from '#api/types.ts';
import Markdown from '#components/ui/Markdown.vue';
import DependenciesCard from '#components/work/overview/DependenciesCard.vue';
import DocumentsCard from '#components/work/overview/DocumentsCard.vue';
import FinalMessage from '#components/runs/FinalMessage.vue';
import PlanCard from '#components/work/overview/PlanCard.vue';
import ProposalCheckCard from '#components/work/overview/ProposalCheckCard.vue';
import PullRequestCard from '#components/landing/PullRequestCard.vue';
import VerifyCard from '#components/runs/VerifyCard.vue';
import VerifyFindings from '#components/runs/VerifyFindings.vue';
import { latestVerify } from '#daemon/domain/runs/index.ts';

const props = defineProps<{ task: TaskDetail; changes: Changes | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ run: [runId: number]; path: [path: string, line: number | null] }>();

const promptOpen = ref(false);
const longPrompt = computed(() => props.task.prompt.length > 900 || props.task.prompt.split('\n').length > 18);

type Item =
  | { kind: 'event'; key: string; at: string; ev: TaskEventRow; said: PersonEventText; icon: string }
  | { kind: 'created'; key: string; at: string }
  | { kind: 'run'; key: string; at: string; run: Run; latest: boolean };

const EVENT_ICON: Record<string, string> = { retry: '↻', approve: '✓', mark_done: '✓' };

const items = computed<Item[]>(() => {
  const events = props.task.events ?? [];
  const out: Item[] = [];
  const created = events.find((e) => e.type === 'created');
  out.push({ kind: 'created', key: 'created', at: created?.at ?? props.task.created_at });
  for (const ev of events) {
    const said = describeEvent(ev, 'person');
    if (said) out.push({ kind: 'event', key: `event-${ev.id}`, at: ev.at, ev, said, icon: EVENT_ICON[ev.type] ?? '•' });
  }
  const last = props.task.runs.at(-1)?.id;
  for (const run of props.task.runs) out.push({ kind: 'run', key: `run-${run.id}`, at: run.started_at, run, latest: run.id === last });
  return out.sort((a, b) => a.at.localeCompare(b.at));
});

const outcomeClass = (r: Run) => `s-${r.outcome ?? 'running'}`;

const item = 'relative flex flex-wrap items-baseline gap-2 py-2 pr-0 pl-4';
const node = 'absolute top-[7px] -left-[21px] grid size-5 place-items-center rounded-full bg-bg text-sm text-muted';
const when = 'ml-auto text-sm text-muted';
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4.5">
    <ProposalCheckCard :task="task" />

    <VerifyCard :task="task" @path="(p, l) => emit('path', p, l)" />

    <article class="card">
      <header class="card-head gap-1.5 px-3.5 py-2">
        <b>{{ task.source === 'planner' ? 'Planner' : 'You' }}</b>
        <span class="text-muted">wrote the prompt {{ ago(task.created_at) }}</span>
      </header>
      <div
        class="px-3.5 py-3"
        :class="longPrompt && !promptOpen && 'max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'"
      >
        <Markdown :text="task.prompt" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
      </div>
      <button
        v-if="longPrompt"
        class="w-full rounded-none border-0 border-t border-border bg-transparent p-1.5 text-accent"
        @click="promptOpen = !promptOpen"
      >
        {{ promptOpen ? 'Show less' : 'Show all' }}
      </button>
    </article>

    <PullRequestCard :task="task" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />

    <DependenciesCard :task="task" />

    <PlanCard v-for="p in task.plans ?? []" :key="p.id" :task-id="task.id" :plan="p" @open="(path) => emit('path', path, null)" />

    <DocumentsCard
      :task-id="task.id"
      :files="changes?.files ?? []"
      :head="changes?.head ?? null"
      :is-path="isPath"
      @open="(p) => emit('path', p, null)"
      @path="(p, l) => emit('path', p, l)"
    />

    <ol class="my-0 ml-3 list-none border-l-2 border-border pl-2.5">
      <li v-for="it in items" :key="it.key" :class="[item, it.kind === 'run' && outcomeClass(it.run)]">
        <template v-if="it.kind === 'created'">
          <span :class="node">○</span>
          <span
            ><b>{{ task.source === 'planner' ? 'The planner' : 'You' }}</b> created this task</span
          >
          <span :class="when">{{ ago(it.at) }}</span>
        </template>
        <template v-else-if="it.kind === 'event'">
          <span :class="node">{{ it.icon }}</span>
          <span>
            {{ it.said.text }}
            <span v-if="it.said.reason" class="text-muted"> · {{ it.said.reason }}</span>
          </span>
          <span :class="when">{{ ago(it.at) }}</span>
        </template>
        <template v-else>
          <div class="flex w-full flex-wrap items-baseline gap-1.5">
            <span :class="node" class="dot after:size-2.5 after:rounded-full after:bg-[var(--c,var(--running))]" />
            <button class="btn-ghost font-semibold hover:text-accent" @click="emit('run', it.run.id)">
              {{ runLabel(it.run) }}
            </button>
            <span class="font-medium text-[color:var(--c,var(--running))]">{{ it.run.outcome ?? 'running' }}</span>
            <span class="text-muted">
              · {{ runDuration(it.run) }}
              <template v-if="it.run.num_turns"> · {{ it.run.num_turns }} turns</template>
              <template v-if="totalTokens(it.run)"> · {{ fmtTokens(totalTokens(it.run)) }} tokens</template>
              <template v-if="it.run.tests_passed !== null"> · tests {{ it.run.tests_passed ? 'passed' : 'failed' }}</template>
              <template v-if="it.run.denials"> · {{ it.run.denials }} refused</template>
            </span>
            <span :class="when">{{ ago(it.at) }}</span>
          </div>
          <VerifyFindings
            v-if="it.run.kind === 'verify' && it.run.ended_at"
            class="w-full"
            :view="latestVerify([it.run], null)!"
            @path="(p, l) => emit('path', p, l)"
          />
          <FinalMessage v-else-if="it.run.result_text" class="w-full" :open="it.latest">
            <Markdown :text="it.run.result_text" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
          </FinalMessage>
        </template>
      </li>
      <li v-if="task.pr_url" :class="item">
        <span :class="node">⎇</span>
        <span>Pull request {{ task.pr_state ?? 'open' }}</span>
      </li>
    </ol>
  </div>
</template>
