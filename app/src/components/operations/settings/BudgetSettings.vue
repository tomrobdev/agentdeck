<script setup lang="ts">
import { computed } from 'vue';
import type { SettingsForm } from '#lib/shared/forms.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';
import NumberInput from '#components/ui/form/NumberInput.vue';
import PercentField from '#components/operations/settings/PercentField.vue';

const props = defineProps<{ form: SettingsForm }>();

const perDay = computed(() => (props.form.weekly_max / 7).toFixed(1));
</script>

<template>
  <FieldSection
    id="settings-budget"
    title="Usage budget"
    hint="AgentDeck reads your 5-hour and 7-day usage from Claude. These limits only decide when new tasks may start, never stop a running one, so the rest stays free for your own Claude use."
  >
    <PercentField v-model="form.five_hour_max" label="5-hour cap" hint="No new task starts above this." />
    <PercentField v-model="form.five_hour_soft" label="5-hour soft limit" hint="One task at a time above this." />
    <PercentField v-model="form.weekly_max" label="Weekly cap" :hint="`Spread evenly, about ${perDay}% a day.`" />
    <PercentField v-model="form.pace_slack" label="Pace slack" hint="How far ahead of even pace it may run." />
    <FieldRow label="Slots" hint="How many tasks may run at once.">
      <NumberInput class="w-24" v-model="form.max_concurrent" label="Slots" />
    </FieldRow>
  </FieldSection>
</template>
