<script setup lang="ts">
import { ref } from 'vue';
import { type Repo, api } from '../api';
import Modal from './Modal.vue';

defineProps<{ repos: Repo[] }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const path = ref('');
const name = ref('');
const test = ref('');
const error = ref('');
const saving = ref(false);

async function add() {
  error.value = '';
  saving.value = true;
  try {
    await api.addRepo({ path: path.value.trim(), name: name.value.trim() || undefined, test: test.value.trim() || undefined });
    path.value = name.value = test.value = '';
    emit('changed');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal title="Repos" @close="$emit('close')">
    <ul v-if="repos.length" class="repos">
      <li v-for="r in repos" :key="r.id">
        <div class="name">{{ r.name }} <span class="muted">· base {{ r.base_branch }}</span></div>
        <code class="muted">{{ r.path }}</code>
        <div class="muted small">tests: <code>{{ r.test_cmd ?? 'none' }}</code></div>
      </li>
    </ul>
    <p v-else class="muted">No repos yet.</p>

    <form @submit.prevent="add">
      <h4>Add a repo</h4>
      <label>
        Path to a local git repo
        <input v-model="path" placeholder="~/Documents/Dev/myproject" />
      </label>
      <div class="row">
        <label>
          <span>Name <span class="muted">(optional)</span></span>
          <input v-model="name" />
        </label>
        <label>
          <span>Test command <span class="muted">(run after each task)</span></span>
          <input v-model="test" placeholder="npm test" />
        </label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="actions">
        <button class="primary" type="submit" :disabled="saving || !path.trim()">Add repo</button>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.repos {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.repos li {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.name {
  font-weight: 600;
}
.small {
  font-size: 12px;
}
h4 {
  margin: 0;
}
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
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
.actions {
  display: flex;
  justify-content: flex-end;
}
.error {
  color: var(--failed);
  margin: 0;
}
</style>
