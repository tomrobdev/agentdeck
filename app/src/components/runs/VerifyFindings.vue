<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { VerifyView } from '#api/types.ts';
import { RouterLink } from 'vue-router';
import { type ClaimVerdict, findingPlace } from '#daemon/domain/runs/index.ts';
import { verifyFileRef } from '#daemon/domain/work/index.ts';
import { VERDICT_MARKS, findingFile, sortFindings, verdictCounts, verdictsShownFirst, verifyAt, verifyHeadline } from '#lib/runs/verify.ts';
import { useCopy } from '#platform/native.ts';
import FindingCode from '#components/runs/FindingCode.vue';
import Chip from '#components/ui/Chip.vue';
import Disclosure from '#components/ui/disclosure/Disclosure.vue';
import DisclosureContent from '#components/ui/disclosure/DisclosureContent.vue';
import DisclosureTrigger from '#components/ui/disclosure/DisclosureTrigger.vue';
import ChipToggle from '#components/ui/form/ChipToggle.vue';

const props = defineProps<{ view: VerifyView; taskId: number; compact?: boolean }>();

const counts = computed(() => verdictCounts(props.view.findings));
const on = ref<ClaimVerdict[]>([]);
watch(
  () => [props.view.run_id, props.view.state],
  () => (on.value = verdictsShownFirst(props.view.findings)),
  { immediate: true },
);
const toggle = (v: ClaimVerdict, show: boolean) => (on.value = show ? [...on.value, v] : on.value.filter((x) => x !== v));
const cards = computed(() =>
  sortFindings(props.view.findings)
    .filter((f) => on.value.includes(f.verdict))
    .map((f) => ({ f, file: findingFile(f) })),
);
const { copied, copy } = useCopy();
const EDGE = { done: 'border-l-done', failed: 'border-l-failed', blocked: 'border-l-blocked' } as const;
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" data-verify-findings>
    <div v-if="counts.length" class="flex flex-wrap items-center gap-1.5 text-sm">
      <ChipToggle
        v-for="c in counts"
        :key="c.verdict"
        :tone="VERDICT_MARKS[c.verdict].tone"
        :model-value="on.includes(c.verdict)"
        :title="`${on.includes(c.verdict) ? 'Hide' : 'Show'} the ${c.verdict} claims`"
        :data-verdict-filter="c.verdict"
        @update:model-value="(show) => toggle(c.verdict, show)"
        >{{ VERDICT_MARKS[c.verdict].icon }} {{ c.count }} {{ VERDICT_MARKS[c.verdict].label }}</ChipToggle
      >
      <span class="ml-auto" :class="view.stale ? 'text-blocked' : 'text-muted'">
        {{ verifyAt(view) }}
      </span>
    </div>
    <p
      v-else
      class="m-0 text-sm wrap-anywhere"
      :class="view.state === 'failed' ? 'text-failed' : view.stale ? 'text-blocked' : 'text-muted'"
    >
      {{ verifyHeadline(view) }}
    </p>
    <ul v-if="cards.length" class="m-0 flex list-none flex-col gap-2 p-0">
      <Disclosure
        v-for="{ f, file } in cards"
        :key="`${view.run_id}-${f.verdict}-${f.claim}`"
        v-slot="{ open }"
        as="li"
        :default-open="f.verdict !== 'true'"
        class="min-w-0 overflow-hidden rounded-md border border-l-3 border-border text-sm"
        :class="EDGE[VERDICT_MARKS[f.verdict].tone]"
        :data-verdict="f.verdict"
        :aria-label="`${VERDICT_MARKS[f.verdict].label}: ${f.claim}`"
      >
        <div class="flex min-w-0 items-center gap-2 bg-panel-2 px-2.5 py-1.5">
          <DisclosureTrigger class="btn-ghost flex min-w-0 flex-1 items-center gap-2 p-0 text-left">
            <span class="w-3 flex-none text-muted">{{ open ? '▾' : '▸' }}</span>
            <Chip class="flex-none" :tone="VERDICT_MARKS[f.verdict].tone"
              >{{ VERDICT_MARKS[f.verdict].icon }} {{ VERDICT_MARKS[f.verdict].label }}</Chip
            >
            <span
              v-if="file"
              class="flex min-w-0 font-mono"
              :class="open ? 'flex-1' : 'max-w-[45%] flex-none'"
              :title="findingPlace(f) ?? ''"
            >
              <span class="truncate text-muted">{{ file.folder }}</span>
              <span class="flex-none">{{ file.name }}</span>
            </span>
            <span v-else class="flex-none text-muted">No file</span>
            <span v-if="!open" class="min-w-0 flex-1 truncate text-muted">{{ f.claim }}</span>
          </DisclosureTrigger>
          <RouterLink
            v-if="file && view.commit && !compact"
            class="btn btn-ghost flex-none p-0 text-accent"
            :to="{ name: 'task', params: { id: taskId, tab: 'code' }, query: { ref: verifyFileRef(view.run_id), ...file.query } }"
          >
            Open file
          </RouterLink>
        </div>
        <DisclosureContent class="flex min-w-0 flex-col border-t border-border">
          <div class="flex flex-col gap-1 px-3 py-2">
            <span class="font-medium wrap-anywhere">{{ f.claim }}</span>
            <span v-if="f.evidence" class="text-muted wrap-anywhere">{{ f.evidence }}</span>
          </div>
          <FindingCode
            v-if="f.path && file?.range && view.commit"
            :class="compact && 'px-3 pb-2'"
            :task-id="taskId"
            :run="view.run_id"
            :commit="view.commit"
            :path="f.path"
            :range="file.range"
            :compact="compact"
          />
          <span v-if="f.fix" class="flex min-w-0 items-baseline gap-2 px-3 py-2">
            <span class="flex-none text-muted">Suggested fix</span>
            <span class="min-w-0 flex-1 wrap-anywhere">{{ f.fix }}</span>
            <button class="btn-mini flex-none" title="Copy the suggested fix" @click="copy(f.fix, f.claim)">
              {{ copied === f.claim ? 'Copied' : 'Copy' }}
            </button>
          </span>
        </DisclosureContent>
      </Disclosure>
    </ul>
  </div>
</template>
