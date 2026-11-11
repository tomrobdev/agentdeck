<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { taskQuery, tasksQuery } from '#api/work.ts';
import { editRefusal } from '#lib/work/queue/bulk.ts';
import { MODELS } from '#daemon/domain/work/index.ts';
import { useActions } from '#composables/shared/useActions.ts';
import type { EditKeys, KeyEdit } from '#composables/work/useEditKeys.ts';
import Modal from '#components/ui/Modal.vue';

const props = defineProps<{ kind: KeyEdit; keys: EditKeys }>();
const { flash } = useActions();
const targets = computed(() => props.keys.targets.value);
const heading = computed(() => (targets.value.length === 1 ? `#${targets.value[0].id}` : `${targets.value.length} tasks`));

const first = computed(() => targets.value[0]?.id ?? 0);
const detail = useQuery(computed(() => ({ ...taskQuery(first.value), enabled: props.kind === 'prompt' && first.value > 0 })));
const prompt = ref('');
const loaded = ref(false);
watch(
  () => detail.data.value?.prompt,
  (text) => {
    if (text === undefined || loaded.value) return;
    prompt.value = text;
    loaded.value = true;
  },
  { immediate: true },
);
async function savePrompt() {
  const refusal = targets.value[0] && editRefusal(targets.value[0], 'priority');
  if (refusal) return flash(`#${first.value} ${refusal}`);
  if (!prompt.value.trim()) return flash("The prompt can't be empty.");
  if (await props.keys.savePrompt(first.value, prompt.value)) props.keys.close();
}

async function pickModel(model: string) {
  props.keys.close();
  await props.keys.setModel(model);
}

const all = useQuery(tasksQuery());
const others = computed(() => (all.data.value ?? []).filter((t) => !targets.value.some((x) => x.id === t.id)));
const linkTo = ref('');
const linkId = () => Number(/^#?(\d+)/.exec(linkTo.value.trim())?.[1] ?? 0);
async function link(kind: 'builds_on' | 'after') {
  const on = linkId();
  if (on < 1) return flash('Enter the task to link as #id');
  props.keys.close();
  await props.keys.setLink(kind, on);
}
</script>

<template>
  <Modal v-if="kind === 'prompt'" :title="`Edit the prompt of ${heading}`" @close="keys.close()">
    <textarea
      v-model="prompt"
      class="w-full resize-y"
      rows="12"
      aria-label="Prompt"
      :disabled="!loaded"
      @keydown.enter.meta.prevent="savePrompt"
      @keydown.enter.ctrl.prevent="savePrompt"
    />
    <div class="mt-3 flex justify-end gap-2">
      <button @click="keys.close()">Cancel</button>
      <button class="primary" :disabled="!loaded || keys.pending.value" @click="savePrompt">Save</button>
    </div>
  </Modal>

  <Modal v-else-if="kind === 'model'" :title="`Set the model of ${heading}`" @close="keys.close()">
    <div class="flex flex-col gap-1" role="group" aria-label="Model">
      <button v-for="m in MODELS" :key="m" class="text-left" @click="pickModel(m)">{{ m }}</button>
    </div>
  </Modal>

  <Modal v-else :title="`Link ${heading} to another task`" @close="keys.close()">
    <input
      v-model="linkTo"
      list="key-link-tasks"
      class="w-full px-1.5 py-0.5"
      placeholder="#id of the other task"
      aria-label="Task to link"
      @keydown.enter="link('builds_on')"
    />
    <datalist id="key-link-tasks">
      <option v-for="t in others" :key="t.id" :value="`#${t.id} ${t.title}`" />
    </datalist>
    <div class="mt-3 flex justify-end gap-2">
      <button @click="link('after')">After…</button>
      <button class="primary" @click="link('builds_on')">Builds on…</button>
    </div>
  </Modal>
</template>
