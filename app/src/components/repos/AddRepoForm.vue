<script setup lang="ts">
import { ref } from 'vue';
import { reposApi } from '#api/repos.ts';
import type { Repo } from '#api/types.ts';
import { useActions } from '#composables/shared/useActions.ts';
import { isNative, pickFolder } from '#platform/native.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';

const emit = defineEmits<{ added: [repo: Repo] }>();
const { run } = useActions();

const path = ref('');
const name = ref('');
const test = ref('');
const saving = ref(false);

async function choose() {
  const picked = await pickFolder();
  if (picked) path.value = picked;
}

async function add() {
  saving.value = true;
  let repo: Repo | undefined;
  const ok = await run(async () => {
    repo = await reposApi.addRepo({ path: path.value.trim(), name: name.value.trim() || undefined, test: test.value.trim() || undefined });
  });
  saving.value = false;
  if (!ok || !repo) return;
  path.value = name.value = test.value = '';
  emit('added', repo);
}
</script>

<template>
  <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="add">
    <div class="pane-body">
      <FieldSection
        title="Add a repo"
        hint="Its toolchain is detected, with a setup command and tool rules to match; change them once it is added."
      >
        <FieldRow label="Path" hint="A local git repo.">
          <span class="flex gap-2">
            <input v-model="path" class="flex-1 font-mono" spellcheck="false" placeholder="~/Documents/Dev/myproject" />
            <button v-if="isNative" type="button" @click="choose">Choose…</button>
          </span>
        </FieldRow>
        <FieldRow label="Name" hint="Optional. The folder's name otherwise.">
          <input v-model="name" class="max-w-xs" />
        </FieldRow>
        <FieldRow label="Test command" hint="Optional. Runs after each task.">
          <input v-model="test" class="font-mono" spellcheck="false" placeholder="npm test" />
        </FieldRow>
      </FieldSection>
    </div>
    <footer class="pane-footer justify-end">
      <button class="primary" type="submit" :disabled="saving || !path.trim()">Add repo</button>
    </footer>
  </form>
</template>
