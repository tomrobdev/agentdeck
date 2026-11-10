<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { workApi } from '../../../api/work';
import { MODEL_HINTS, MODEL_LABELS } from '../../../lib/runs/run-wording';
import { settingsQuery } from '../../../api/operations';
import type { Repo, TaskDetail } from '../../../api/types';
import { errorMessage, textList } from '../../../../../daemon/src/domain/shared/index.ts';
import { modelSourceText, newTaskModel } from '../../../../../daemon/src/domain/work/index.ts';
import { modelChoices } from '../../../lib/shared/forms';
import { useTerminal } from '../../../composables/runs/useTerminal';
import { openPanel } from '../../../composables/shared/useShell';
import Modal from '../../ui/Modal.vue';
import NumberInput from '../../ui/form/NumberInput.vue';

const props = defineProps<{ repos: Repo[] }>();
const emit = defineEmits<{ close: []; created: [task: TaskDetail] }>();

const repo = ref(props.repos[0]?.name ?? '');
const title = ref('');
const prompt = ref('');
const settingsQ = useQuery(settingsQuery());
const picked = ref<string | null>(null);
const byDefault = computed(() => {
  const defaultModel = settingsQ.data.value?.default_model;
  if (!defaultModel) return null;
  return newTaskModel(undefined, { model: props.repos.find((r) => r.name === repo.value)?.model ?? null }, defaultModel);
});
const model = computed({
  get: () => picked.value ?? byDefault.value?.model ?? '',
  set: (m: string) => (picked.value = m),
});
const modelSource = computed(() => (picked.value === null && byDefault.value ? modelSourceText(byDefault.value.source) : null));
const priority = ref(0);
const maxTurns = ref(40);
const planTask = ref('');
const planSteps = ref('');
const error = ref('');
const saving = ref(false);
const saved = ref<TaskDetail | null>(null);
const warnings = ref<string[]>([]);

const terminal = useTerminal();

async function writeWithClaude() {
  const path = props.repos.find((r) => r.name === repo.value)?.path;
  if (!path) return;
  error.value = '';
  try {
    await terminal.writeTask(repo.value, path, prompt.value);
    emit('close');
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function submit() {
  if (saved.value) return emit('created', saved.value);
  if (saving.value || !prompt.value.trim()) return;
  error.value = '';
  const planOn = planTask.value.trim().replace(/^#/, '');
  if (planOn && !/^\d+$/.test(planOn)) {
    error.value = 'Plan: give the number of the task whose plan this one follows.';
    return;
  }
  saving.value = true;
  try {
    const task = await workApi.addTask({
      repo: repo.value,
      prompt: prompt.value,
      title: title.value || undefined,
      model: picked.value ?? undefined,
      priority: priority.value,
      max_turns: maxTurns.value,
      plan_task: planOn ? Number(planOn) : undefined,
      plan_steps: textList(planSteps.value),
    });
    if (task.warnings.length) {
      saved.value = task;
      warnings.value = task.warnings;
    } else emit('created', task);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal title="New task" focus="textarea" @close="$emit('close')">
    <div v-if="!repos.length">
      <p class="mt-0">Register a repo first. Tasks run in a worktree of a git repository.</p>
      <button class="primary" @click="openPanel('repos')">Add a repo</button>
    </div>
    <form v-else class="flex flex-col gap-3" @submit.prevent="submit" @keydown.meta.enter="submit">
      <label class="field flex-1">
        What should the agent do?
        <textarea
          class="resize-y"
          v-model="prompt"
          rows="7"
          placeholder="Small, testable, with a clear definition of done. e.g. Add a slugify(s) helper to src/strings.js with tests for edge cases."
        />
      </label>
      <label class="field flex-1">
        <span>Title <span class="text-muted">(optional, defaults to the first sentence)</span></span>
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
          <span
            >Model <span v-if="modelSource" class="text-muted">({{ modelSource }})</span></span
          >
          <select v-model="model">
            <option v-for="m in modelChoices(model)" :key="m" :value="m">
              {{ MODEL_LABELS[m] ?? m }}<template v-if="MODEL_HINTS[m]"> ({{ MODEL_HINTS[m] }})</template>
            </option>
          </select>
        </label>
        <label class="field flex-[0_0_84px]">
          Priority
          <NumberInput v-model="priority" />
        </label>
        <label class="field flex-[0_0_84px]">
          Max turns
          <NumberInput v-model="maxTurns" />
        </label>
      </div>
      <div class="flex gap-2.5">
        <label class="field flex-1">
          <span>Plan <span class="text-muted">(optional, the task whose plan this one follows)</span></span>
          <input v-model="planTask" placeholder="#112" inputmode="numeric" />
        </label>
        <label class="field flex-1">
          <span>Steps <span class="text-muted">(ids, comma-separated; blank for every unfinished step)</span></span>
          <input v-model="planSteps" placeholder="step-a, step-b" :disabled="!planTask.trim()" />
        </label>
      </div>
      <p v-if="error" class="form-error">{{ error }}</p>
      <div v-if="warnings.length" class="text-blocked">
        <p class="m-0">Queued, but check the prompt:</p>
        <ul class="m-0 pl-5">
          <li v-for="w in warnings" :key="w">{{ w }}</li>
        </ul>
      </div>
      <div class="flex items-center justify-end gap-2">
        <span class="text-muted mr-auto text-sm">⌘↩ to queue</span>
        <button
          v-if="!saved && terminal.available.value"
          type="button"
          title="Opens a terminal in the repo running claude /add-task with what you typed"
          @click="writeWithClaude"
        >
          Write it with Claude
        </button>
        <button v-if="!saved" type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving || !prompt.trim()">{{ saved ? 'Open task' : 'Queue task' }}</button>
      </div>
    </form>
  </Modal>
</template>
