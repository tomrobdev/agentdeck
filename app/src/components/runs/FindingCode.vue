<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import { fileQuery } from '#api/work.ts';
import { findingPlace } from '#daemon/domain/runs/index.ts';
import type { RunId } from '#daemon/domain/shared/index.ts';
import { verifyFileRef } from '#daemon/domain/work/index.ts';
import { snippetOf } from '#lib/runs/verify.ts';
import CodeView from '#components/ui/code/CodeView.vue';
import Disclosure from '#components/ui/disclosure/Disclosure.vue';
import DisclosureContent from '#components/ui/disclosure/DisclosureContent.vue';
import DisclosureTrigger from '#components/ui/disclosure/DisclosureTrigger.vue';

const props = defineProps<{
  taskId: number;
  run: RunId;
  commit: string;
  path: string;
  line: number | null;
  endLine: number | null;
  compact?: boolean;
}>();

const open = ref(!props.compact);
const at = computed(() => verifyFileRef(props.run));
const range = computed(() => (props.line === null ? null : { from: props.line, to: props.endLine ?? props.line }));
const fileQ = useQuery(
  computed(() => ({
    ...fileQuery(props.taskId, at.value, props.path, props.commit),
    enabled: open.value && range.value !== null,
    retry: false,
  })),
);
const snippet = computed(() => {
  const text = fileQ.data.value?.text;
  return typeof text === 'string' && range.value ? snippetOf(text, range.value) : null;
});
const place = computed(() => findingPlace({ path: props.path, line: props.line, end_line: props.endLine }));
const lineQuery = computed(() =>
  range.value ? { L: range.value.from === range.value.to ? `${range.value.from}` : `${range.value.from}-${range.value.to}` } : {},
);
</script>

<template>
  <Disclosure v-model:open="open" class="min-w-0 overflow-hidden rounded-md border border-border" data-finding-code>
    <div class="flex items-center gap-2 bg-panel-2 px-2.5 py-1 text-xs">
      <DisclosureTrigger
        v-if="range"
        class="btn-ghost min-w-0 flex-1 truncate p-0 text-left font-mono text-muted hover:text-text"
        :title="open ? 'Hide the code' : 'Show the code'"
      >
        {{ open ? '▾' : '▸' }} {{ place }}
      </DisclosureTrigger>
      <span v-else class="min-w-0 flex-1 truncate font-mono text-muted">{{ place }}</span>
      <RouterLink
        v-if="!compact"
        class="btn btn-ghost flex-none p-0 text-accent"
        :to="{ name: 'task', params: { id: taskId, tab: 'code' }, query: { ref: at, path, ...lineQuery } }"
      >
        Open file
      </RouterLink>
    </div>
    <DisclosureContent v-if="range" class="border-t border-border">
      <CodeView v-if="snippet" class="max-h-80 py-1" :text="snippet.text" :path="path" :first="snippet.first" :range="range" />
      <p v-else class="m-0 px-2.5 py-1.5 text-sm text-muted">
        {{ fileQ.isPending.value ? 'Loading…' : (fileQ.error.value?.message ?? 'That line is not in the text of this file.') }}
      </p>
    </DisclosureContent>
  </Disclosure>
</template>
