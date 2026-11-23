<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { VerifyView } from '#api/types.ts';
import type { ClaimVerdict } from '#daemon/domain/runs/index.ts';
import { VERDICT_MARKS, sortFindings, verdictCounts, verdictsShownFirst, verifyHeadline } from '#lib/runs/verify.ts';
import { useCopy } from '#platform/native.ts';
import FindingCode from '#components/runs/FindingCode.vue';
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
const findings = computed(() => sortFindings(props.view.findings).filter((f) => on.value.includes(f.verdict)));
const { copied, copy } = useCopy();
const TONE = { done: 'text-done', failed: 'text-failed', blocked: 'text-blocked' } as const;
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
        <template v-if="view.commit">at {{ view.commit.slice(0, 7) }}</template>
        <template v-if="view.stale"> · stale: the base has moved on since</template>
      </span>
    </div>
    <p
      v-else
      class="m-0 text-sm wrap-anywhere"
      :class="view.state === 'failed' ? 'text-failed' : view.stale ? 'text-blocked' : 'text-muted'"
    >
      {{ verifyHeadline(view) }}
    </p>
    <ul v-if="findings.length" class="m-0 flex list-none flex-col gap-3 p-0">
      <Disclosure
        v-for="f in findings"
        :key="`${view.run_id}-${f.verdict}-${f.claim}`"
        v-slot="{ open }"
        as="li"
        :default-open="f.verdict !== 'true'"
        class="min-w-0 text-sm"
        :data-verdict="f.verdict"
        :aria-label="`${VERDICT_MARKS[f.verdict].label}: ${f.claim}`"
      >
        <DisclosureTrigger class="btn-ghost flex w-full min-w-0 items-baseline gap-2 p-0 text-left whitespace-normal">
          <span class="w-3 flex-none text-muted">{{ open ? '▾' : '▸' }}</span>
          <span class="w-[68px] flex-none font-mono whitespace-nowrap" :class="TONE[VERDICT_MARKS[f.verdict].tone]">
            {{ VERDICT_MARKS[f.verdict].icon }} {{ VERDICT_MARKS[f.verdict].label }}
          </span>
          <span class="min-w-0 flex-1 font-medium wrap-anywhere">{{ f.claim }}</span>
        </DisclosureTrigger>
        <DisclosureContent class="mt-1 flex min-w-0 flex-col gap-1.5 pl-24 max-sm:pl-5">
          <span v-if="f.evidence" class="text-muted wrap-anywhere">{{ f.evidence }}</span>
          <FindingCode
            v-if="f.path && view.commit"
            :task-id="taskId"
            :run="view.run_id"
            :commit="view.commit"
            :path="f.path"
            :line="f.line"
            :end-line="f.end_line"
            :compact="compact"
          />
          <span v-if="f.fix" class="flex min-w-0 items-baseline gap-2">
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
