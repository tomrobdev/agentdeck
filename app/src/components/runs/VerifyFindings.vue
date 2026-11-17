<script setup lang="ts">
import { computed } from 'vue';
import type { VerifyView } from '#api/types.ts';
import { findingPlace } from '#daemon/domain/runs/index.ts';
import { VERDICT_MARKS, sortFindings, verifyHeadline } from '#lib/runs/verify.ts';

const props = defineProps<{ view: VerifyView }>();
const emit = defineEmits<{ path: [path: string, line: number | null] }>();

const findings = computed(() => sortFindings(props.view.findings));
const TONE = { done: 'text-done', failed: 'text-failed', blocked: 'text-blocked' } as const;
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5" data-verify-findings>
    <p class="m-0 text-sm wrap-anywhere" :class="view.state === 'failed' ? 'text-failed' : view.stale ? 'text-blocked' : 'text-muted'">
      {{ verifyHeadline(view) }}
    </p>
    <ul v-if="findings.length" class="m-0 flex list-none flex-col gap-1.5 p-0">
      <li
        v-for="(f, i) in findings"
        :key="i"
        class="flex min-w-0 flex-col gap-0.5 text-sm"
        :data-verdict="f.verdict"
        :aria-label="`${VERDICT_MARKS[f.verdict].label}: ${f.claim}`"
      >
        <span class="flex min-w-0 items-baseline gap-2">
          <span class="w-14 flex-none font-mono" :class="TONE[VERDICT_MARKS[f.verdict].tone]">
            {{ VERDICT_MARKS[f.verdict].icon }} {{ VERDICT_MARKS[f.verdict].label }}
          </span>
          <span class="min-w-0 flex-1 wrap-anywhere">{{ f.claim }}</span>
          <button
            v-if="f.path"
            class="btn-ghost flex-none font-mono text-muted hover:text-accent"
            :title="`Open ${findingPlace(f)}`"
            @click="emit('path', f.path, f.line)"
          >
            {{ findingPlace(f) }}
          </button>
        </span>
        <span v-if="f.evidence" class="pl-16 text-muted wrap-anywhere">{{ f.evidence }}</span>
        <span v-if="f.fix" class="pl-16 wrap-anywhere"><span class="text-muted">Fix:</span> {{ f.fix }}</span>
      </li>
    </ul>
  </div>
</template>
