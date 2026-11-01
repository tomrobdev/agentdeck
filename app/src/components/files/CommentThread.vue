<script setup lang="ts">
import { api } from '../../api';
import type { ShownComment } from '../../composables/useReviews';
import { useActions } from '../../composables/useActions';

// One review comment under its diff line: its text, the answer it got and its state.
const props = defineProps<{ comment: ShownComment; outdated?: boolean }>();
const { busy, run } = useActions();
const remove = () => run(() => api.deleteComment(props.comment.id));
const resolve = () => run(() => api.resolveComment(props.comment.id));
const reopen = () => run(() => api.reopenComment(props.comment.id));
</script>

<template>
  <div class="my-1.5 rounded-md border border-border bg-panel px-3 py-2 font-sans text-base whitespace-normal">
    <div class="mb-1 flex items-center gap-1.5 text-sm text-muted">
      <span class="rounded-full bg-panel-2 px-2 py-px text-xs font-medium" :class="comment.draft ? 'text-blocked' : ''">
        {{ comment.draft ? 'Pending' : comment.state }}
      </span>
      <span v-if="outdated" class="font-mono text-xs">{{ comment.side === 'old' ? 'old ' : '' }}line {{ comment.line }}</span>
      <span v-if="outdated" class="rounded-full bg-panel-2 px-2 py-px text-xs">Outdated</span>
      <div class="spacer" />
      <button v-if="comment.draft" class="btn-mini" :disabled="busy" @click="remove">Delete</button>
      <button v-else-if="comment.state !== 'resolved'" class="btn-mini" :disabled="busy" @click="resolve">Resolve</button>
      <button v-if="!comment.draft && comment.state !== 'open'" class="btn-mini" :disabled="busy" @click="reopen">Reopen</button>
    </div>
    <div class="wrap-anywhere whitespace-pre-wrap">{{ comment.body }}</div>
    <div v-if="comment.answer" class="mt-2 border-l-2 border-accent pl-2.5">
      <div class="text-sm text-muted">Answer</div>
      <div class="wrap-anywhere whitespace-pre-wrap">{{ comment.answer }}</div>
    </div>
  </div>
</template>
