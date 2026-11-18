<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { landingApi } from '#api/landing.ts';
import type { Review, SubmitReview } from '#api/types.ts';
import { plural } from '#daemon/domain/shared/index.ts';
import { useAction } from '#composables/shared/useActions.ts';

const props = defineProps<{ taskId: number; draft: Review | null; kind: SubmitReview['kind'] }>();
const emit = defineEmits<{ close: []; submitted: [] }>();
const { pending, run } = useAction();

const note = ref(props.draft?.body ?? '');
watch(
  () => props.draft?.id,
  () => (note.value = props.draft?.body ?? ''),
);

const count = () => props.draft?.comments.length ?? 0;
const canSubmit = () => !pending.value && (note.value.trim() !== '' || count() > 0);

async function saveNote() {
  const draft = props.draft;
  if (!draft || note.value === draft.body) return;
  try {
    await landingApi.editReview(draft.id, note.value);
  } catch {}
}

async function submit(kind: SubmitReview['kind']) {
  if (!canSubmit()) return;
  const ok = await run(async () => {
    const review = props.draft ?? (await landingApi.startReview(props.taskId));
    await landingApi.submitReview(review.id, { kind, body: note.value });
  });
  if (ok) {
    note.value = '';
    emit('submitted');
  }
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
    if (document.querySelector('[role=dialog], [role=alertdialog]')) return;
    e.preventDefault();
    void submit(props.kind);
  }
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="mx-6 mt-3 flex flex-none flex-col gap-2 rounded-md border border-accent bg-panel px-3.5 py-2.5" aria-label="Review">
    <div class="flex items-center gap-2">
      <b>Review</b>
      <span class="text-muted">{{ plural(count(), 'comment') }} pending</span>
      <div class="spacer" />
      <button v-if="!count()" class="border-0 bg-transparent text-muted" aria-label="Close" @click="emit('close')">✕</button>
    </div>
    <textarea
      v-model="note"
      class="w-full resize-y"
      rows="2"
      placeholder="Overall note (optional with comments)"
      @blur="saveNote"
      @keydown.esc="emit('close')"
    />
    <div class="flex items-center justify-end gap-1.5">
      <span class="mr-auto text-sm text-muted">⌘Enter submits as {{ kind === 'comment' ? 'Comment' : 'Request changes' }}</span>
      <button :class="{ primary: kind === 'comment' }" :disabled="!canSubmit()" @click="submit('comment')">Submit as Comment</button>
      <button :class="{ primary: kind === 'request_changes' }" :disabled="!canSubmit()" @click="submit('request_changes')">
        ↻ Request changes
      </button>
    </div>
  </div>
</template>
