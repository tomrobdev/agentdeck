<script setup lang="ts">
import { ref } from 'vue';
import { type TaskDetail, api } from '../../../api';
import type { UnblockQuestion } from '../../../../../daemon/src/domain/work/index.ts';
import { answerNote } from '../../../lib/task/task-view';
import { useAction } from '../../../composables/shared/useActions';

// What an unblock run asked about a blocked task: one button per option, each retrying the task with that option as
// the note. "Something else…" opens a field for your own note.
const props = defineProps<{ task: TaskDetail; question: UnblockQuestion }>();
const { pending, run } = useAction();
const other = ref(false);
const note = ref('');

const answer = (text: string) => run(() => api.retry(props.task.id, text));
</script>

<template>
  <div class="callout s-blocked" data-question>
    <div class="wrap-anywhere"><strong>Asks you:</strong> {{ question.question }}</div>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button v-for="o in question.options" :key="o" :disabled="pending" @click="answer(answerNote(question, o))">{{ o }}</button>
      <button :disabled="pending" @click="other = !other">Something else…</button>
    </div>
    <form v-if="other" class="mt-2 flex items-start gap-2" @submit.prevent="note.trim() && answer(note.trim())">
      <textarea v-model="note" class="min-w-0 flex-1" rows="2" placeholder="A note for the worker" aria-label="Retry note" />
      <button class="primary" :disabled="pending || !note.trim()">Retry with note</button>
    </form>
  </div>
</template>
