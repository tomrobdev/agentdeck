<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { type Repo, type TaskDetail, api } from '../api';
import Modal from './Modal.vue';

const props = defineProps<{ repos: Repo[] }>();
const emit = defineEmits<{ close: []; created: [task: TaskDetail]; repos: [] }>();

const repo = ref(props.repos[0]?.name ?? '');
const title = ref('');
const prompt = ref('');
const model = ref('sonnet');
const priority = ref(0);
const maxTurns = ref(40);
const error = ref('');
const saving = ref(false);
const promptEl = ref<HTMLTextAreaElement | null>(null);

onMounted(() => promptEl.value?.focus());

async function submit() {
  error.value = '';
  saving.value = true;
  try {
    const task = await api.addTask({
      repo: repo.value,
      prompt: prompt.value,
      title: title.value || undefined,
      model: model.value,
      priority: priority.value,
      max_turns: maxTurns.value,
    });
    emit('created', task);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal title="New task" @close="$emit('close')">
    <div v-if="!repos.length">
      <p class="mt-0">Register a repo first. Tasks run in a worktree of a git repository.</p>
      <button class="primary" @click="$emit('repos')">Add a repo</button>
    </div>
    <form v-else class="flex flex-col gap-3" @submit.prevent="submit" @keydown.meta.enter="submit">
      <label class="field flex-1">
        What should the agent do?
        <textarea
          class="resize-y"
          ref="promptEl"
          v-model="prompt"
          rows="7"
          placeholder="Small, testable, with a clear definition of done. e.g. Add a slugify(s) helper to src/strings.js with tests for edge cases."
        />
      </label>
      <label class="field flex-1">
        <span>Title <span class="muted">(optional, defaults to the first sentence)</span></span>
        <input v-model="title" />
      </label>
      <div class="flex gap-2.5">
        <label class="field flex-1">
          Repo
          <select v-model="repo">
            <option v-for="r in repos" :key="r.id" :value="r.name">{{ r.name }}</option>
          </select>
        </label>
        <label class="field flex-1">
          Model
          <select v-model="model">
            <option value="haiku">Haiku (cheap, simple)</option>
            <option value="sonnet">Sonnet (default)</option>
            <option value="opus">Opus (hard tasks)</option>
          </select>
        </label>
        <label class="field flex-[0_0_84px]">
          Priority
          <input type="number" v-model.number="priority" />
        </label>
        <label class="field flex-[0_0_84px]">
          Max turns
          <input type="number" v-model.number="maxTurns" min="1" />
        </label>
      </div>
      <p v-if="error" class="form-error">{{ error }}</p>
      <div class="flex items-center justify-end gap-2">
        <span class="muted mr-auto text-sm">⌘↩ to queue</span>
        <button type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving || !prompt.trim()">Queue task</button>
      </div>
    </form>
  </Modal>
</template>
