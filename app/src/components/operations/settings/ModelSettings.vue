<script setup lang="ts">
import { MODEL_LABELS } from '#lib/runs/run-wording.ts';
import { type SettingsForm, modelChoices } from '#lib/shared/forms.ts';
import { MODELS } from '#daemon/domain/work/index.ts';
import NumberInput from '#components/ui/form/NumberInput.vue';
import Switch from '#components/ui/form/Switch.vue';

defineProps<{ form: SettingsForm }>();
</script>

<template>
  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Models</h4>
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <label class="field">
        <span>Default model <span class="text-muted">(a new task's, unless it or its repo names one)</span></span>
        <select v-model="form.default_model">
          <option v-for="m in modelChoices(form.default_model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
        </select>
      </label>
      <label class="field">
        <span>Support model <span class="text-muted">(resolve and unblock runs)</span></span>
        <select v-model="form.support_model">
          <option v-for="m in modelChoices(form.support_model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
        </select>
      </label>
    </div>
  </section>

  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Planner</h4>
    <p class="text-muted m-0 text-sm">
      When a repo with goals has nothing queued, the planner reads its goals and code and proposes the next tasks. Write goals under Repos.
    </p>
    <Switch v-model="form.planner_enabled">Propose tasks automatically when a queue runs dry</Switch>
    <div class="grid grid-cols-3 gap-x-4 gap-y-3">
      <label class="field">
        <span>At most every</span>
        <span class="flex items-center gap-1.5 [&_input]:w-20"
          ><NumberInput v-model="form.planner_interval_hours" :step="0.25" />hours</span
        >
      </label>
      <label class="field">
        <span>Tasks per proposal run</span>
        <NumberInput v-model="form.planner_max_tasks" />
      </label>
      <label class="field">
        <span>Planner model</span>
        <select v-model="form.planner_model">
          <option v-for="m in MODELS" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
        </select>
      </label>
    </div>
  </section>
</template>
