<script setup lang="ts">
import { fileSize } from '../../../lib/work/work-wording';
import { type ChangedFile, type NewReviewComment, PATCH_LIMIT } from '../../../api/types';
import type { PatchState } from '../../../composables/work/files/useFilePatches';
import type { ShownComment } from '../../../composables/landing/useReviews';
import { CHANGE_LABEL } from '../../../lib/work/files/changed-tree';
import { isMarkdown } from '../../../lib/shared/render';
import DiffView from './DiffView.vue';
import Markdown from '../../ui/Markdown.vue';
import Checkbox from '../../ui/form/Checkbox.vue';
import Delta from '../../ui/status/Delta.vue';
import Disclosure from '../../ui/disclosure/Disclosure.vue';
import DisclosureContent from '../../ui/disclosure/DisclosureContent.vue';
import DisclosureTrigger from '../../ui/disclosure/DisclosureTrigger.vue';

defineProps<{
  file: ChangedFile;
  patch: PatchState | undefined;
  split: boolean;
  viewed: boolean;
  preview: string | null | undefined;
  comments?: ShownComment[];
  add: (line: Pick<NewReviewComment, 'side' | 'line'>, body: string) => Promise<boolean>;
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ preview: []; view: []; 'update:viewed': [on: boolean] }>();
</script>

<template>
  <Disclosure v-model:open="open" class="card mb-3" :data-path="file.path">
    <header class="card-head sticky top-0 z-[1] px-2.5 py-1.5">
      <DisclosureTrigger
        class="grid size-7 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-panel-2 hover:text-text"
        :title="open ? 'Collapse' : 'Expand'"
      >
        <svg
          viewBox="0 0 16 16"
          class="size-4 transition-transform"
          :class="!open && '-rotate-90'"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </DisclosureTrigger>
      <span class="badge" :class="`b-${file.status}`" :title="CHANGE_LABEL[file.status]">{{ file.status }}</span>
      <span class="truncate font-mono text-sm leading-[normal]">
        <template v-if="file.old_path">{{ file.old_path }} → </template>{{ file.path }}
      </span>
      <Delta class="text-sm" :add="file.additions" :del="file.deletions" />
      <div class="spacer" />
      <button
        v-if="isMarkdown(file.path) && file.status !== 'D'"
        class="btn-mini"
        :class="preview !== undefined && 'border-accent'"
        @click="emit('preview')"
      >
        Preview
      </button>
      <button v-if="file.status !== 'D'" class="btn-mini" title="Open the whole file" @click="emit('view')">View file</button>
      <Checkbox :model-value="viewed" @update:model-value="(v) => emit('update:viewed', v)">Viewed</Checkbox>
    </header>
    <DisclosureContent>
      <div v-if="preview !== undefined" class="px-4.5 py-3.5">
        <Markdown v-if="preview !== null" :text="preview" />
        <p v-else class="text-muted">Loading…</p>
      </div>
      <p v-else-if="file.binary" class="m-0 px-3.5 py-2.5 text-muted">Binary file not shown.</p>
      <p v-else-if="patch?.state === 'error'" class="m-0 px-3.5 py-2.5 text-muted">{{ patch.error }}</p>
      <template v-else-if="patch?.state === 'ok'">
        <DiffView :path="file.path" :patch="patch.patch.patch" :split="split" :comments="comments" :add="add" />
        <p v-if="patch.patch.truncated" class="m-0 px-3.5 py-2.5 text-muted">
          Diff too large: showing the first {{ fileSize(PATCH_LIMIT) }}.
        </p>
      </template>
      <p v-else class="m-0 px-3.5 py-2.5 text-muted">Loading…</p>
    </DisclosureContent>
  </Disclosure>
</template>
