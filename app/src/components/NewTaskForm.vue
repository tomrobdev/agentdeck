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
    <div v-if="!repos.length" class="empty">
      <p>Register a repo first. Tasks run in a worktree of a git repository.</p>
      <button class="primary" @click="$emit('repos')">Add a repo</button>
    </div>
    <form v-else @submit.prevent="submit" @keydown.meta.enter="submit">
      <label>
        What should the agent do?
        <textarea
          ref="promptEl"
          v-model="prompt"
          rows="7"
          placeholder="Small, testable, with a clear definition of done. e.g. Add a slugify(s) helper to src/strings.js with tests for edge cases."
        />
      </label>
      <label>
        <span>Title <span class="muted">(optional, defaults to the first sentence)</span></span>
        <input v-model="title" />
      </label>
      <div class="row">
        <label>
          Repo
          <select v-model="repo">
            <option v-for="r in repos" :key="r.id" :value="r.name">{{ r.name }}</option>
          </select>
        </label>
        <label>
          Model
          <select v-model="model">
            <option value="haiku">Haiku (cheap, simple)</option>
            <option value="sonnet">Sonnet (default)</option>
            <option value="opus">Opus (hard tasks)</option>
          </select>
        </label>
        <label class="narrow">
          Priority
          <input type="number" v-model.number="priority" />
        </label>
        <label class="narrow">
          Max turns
          <input type="number" v-model.number="maxTurns" min="1" />
        </label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <span class="muted">⌘↩ to queue</span>
        <button type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving || !prompt.trim()">Queue task</button>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.row {
  display: flex;
  gap: 10px;
}
.narrow {
  flex: 0 0 84px;
}
textarea {
  resize: vertical;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
.actions .muted {
  margin-right: auto;
  font-size: 12px;
}
.error {
  color: var(--failed);
  margin: 0;
}
.empty p {
  margin-top: 0;
}
</style>
