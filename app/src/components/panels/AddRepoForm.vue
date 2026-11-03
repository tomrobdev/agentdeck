<script setup lang="ts">
import { ref } from 'vue';
import { type Repo, api } from '../../api';
import { useActions } from '../../composables/useActions';
import { isNative, pickFolder } from '../../platform/native';

// Registers a repo; the panel opens its editor once it is added.
const emit = defineEmits<{ added: [repo: Repo] }>();
const { run } = useActions();

const path = ref('');
const name = ref('');
const test = ref('');
const saving = ref(false);

// Desktop app only; cancelling leaves the field as it was.
async function choose() {
  const picked = await pickFolder();
  if (picked) path.value = picked;
}

async function add() {
  saving.value = true;
  let repo: Repo | undefined;
  const ok = await run(async () => {
    repo = await api.addRepo({ path: path.value.trim(), name: name.value.trim() || undefined, test: test.value.trim() || undefined });
  });
  saving.value = false;
  if (!ok || !repo) return;
  path.value = name.value = test.value = '';
  emit('added', repo);
}
</script>

<template>
  <form class="flex flex-col gap-2.5 border-t border-border pt-3.5" @submit.prevent="add">
    <h4 class="m-0">Add a repo</h4>
    <label class="field flex-1">
      Path to a local git repo
      <span class="flex gap-2">
        <input v-model="path" class="flex-1" placeholder="~/Documents/Dev/myproject" />
        <button v-if="isNative" type="button" @click="choose">Choose…</button>
      </span>
    </label>
    <div class="flex gap-2.5">
      <label class="field flex-1">
        <span>Name <span class="text-muted">(optional)</span></span>
        <input v-model="name" />
      </label>
      <label class="field flex-1">
        <span>Test command <span class="text-muted">(run after each task)</span></span>
        <input v-model="test" placeholder="npm test" />
      </label>
    </div>
    <div class="flex items-center justify-end gap-2">
      <button class="primary" type="submit" :disabled="saving || !path.trim()">Add repo</button>
    </div>
  </form>
</template>
