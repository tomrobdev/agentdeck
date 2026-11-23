<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { fileQuery } from '#api/work.ts';
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
  range: { from: number; to: number };
  compact?: boolean;
}>();

const open = ref(!props.compact);
const at = computed(() => verifyFileRef(props.run));
const fileQ = useQuery(
  computed(() => ({
    ...fileQuery(props.taskId, at.value, props.path, props.commit),
    enabled: open.value,
    retry: false,
  })),
);
const snippet = computed(() => {
  const text = fileQ.data.value?.text;
  return typeof text === 'string' ? snippetOf(text, props.range) : null;
});
</script>

<template>
  <Disclosure v-model:open="open" class="min-w-0" data-finding-code>
    <DisclosureTrigger v-if="compact" class="btn-ghost p-0 text-sm text-muted hover:text-text">
      {{ open ? '▾ Hide code' : '▸ Show code' }}
    </DisclosureTrigger>
    <DisclosureContent class="border-y border-border" :class="compact && 'mt-1 border-x'">
      <CodeView v-if="snippet" class="max-h-80 py-1" :text="snippet.text" :path="path" :first="snippet.first" :range="range" />
      <p v-else class="m-0 px-3 py-1.5 text-sm text-muted">
        {{ fileQ.isPending.value ? 'Loading…' : (fileQ.error.value?.message ?? 'That line is not in the text of this file.') }}
      </p>
    </DisclosureContent>
  </Disclosure>
</template>
