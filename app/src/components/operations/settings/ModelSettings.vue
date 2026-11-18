<script setup lang="ts">
import { MODEL_LABELS } from '#lib/runs/run-wording.ts';
import { type SettingsForm, modelChoices } from '#lib/shared/forms.ts';
import { MODELS } from '#daemon/domain/work/index.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';
import SwitchRow from '#components/ui/form/SwitchRow.vue';
import NumberInput from '#components/ui/form/NumberInput.vue';

defineProps<{ form: SettingsForm }>();
</script>

<template>
  <FieldSection id="settings-models" title="Models">
    <FieldRow label="Default model" hint="A new task's, unless it or its repo names one.">
      <select v-model="form.default_model">
        <option v-for="m in modelChoices(form.default_model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
      </select>
    </FieldRow>
    <FieldRow label="Support model" hint="Resolve and unblock runs.">
      <select v-model="form.support_model">
        <option v-for="m in modelChoices(form.support_model)" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
      </select>
    </FieldRow>
  </FieldSection>

  <FieldSection
    id="settings-planner"
    title="Planner"
    hint="When a repo with goals has nothing queued, the planner reads its goals and code and proposes the next tasks. Write goals under Repos."
  >
    <SwitchRow v-model="form.planner_enabled" label="Propose automatically" hint="When a queue runs dry." />
    <FieldRow label="At most every">
      <span class="flex items-center gap-1.5"><NumberInput class="w-24" v-model="form.planner_interval_hours" :step="0.25" />hours</span>
    </FieldRow>
    <FieldRow label="Tasks per proposal run">
      <NumberInput class="w-24" v-model="form.planner_max_tasks" />
    </FieldRow>
    <FieldRow label="Planner model">
      <select v-model="form.planner_model">
        <option v-for="m in MODELS" :key="m" :value="m">{{ MODEL_LABELS[m] ?? m }}</option>
      </select>
    </FieldRow>
  </FieldSection>
</template>
