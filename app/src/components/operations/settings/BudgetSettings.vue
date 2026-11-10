<script setup lang="ts">
import { computed } from 'vue';
import type { SettingsForm } from '../../../lib/shared/forms';
import NumberInput from '../../ui/form/NumberInput.vue';
import PercentField from './PercentField.vue';

const props = defineProps<{ form: SettingsForm }>();

const perDay = computed(() => (props.form.weekly_max / 7).toFixed(1));
</script>

<template>
  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Usage budget</h4>
    <p class="text-muted m-0 text-sm">
      AgentDeck reads your 5-hour and 7-day usage from Claude. It never interrupts a running task; these limits only decide when new tasks
      may start, so the rest stays free for your own Claude use.
    </p>
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <PercentField v-model="form.five_hour_max" label="5h cap" hint="Hold new tasks above this." />
      <PercentField v-model="form.five_hour_soft" label="5h soft limit" hint="One task at a time above this." />
      <PercentField v-model="form.weekly_max" label="Weekly cap" :hint="`Spread evenly: about ${perDay}% a day.`" />
      <PercentField v-model="form.pace_slack" label="Pace slack" hint="How far ahead of even pace it may run." />
      <label class="field">
        <span>Max concurrent tasks</span>
        <NumberInput v-model="form.max_concurrent" />
      </label>
    </div>
  </section>
</template>
