<script setup lang="ts">
import { NOTIFY_LABELS } from '#lib/operations/daemon-wording.ts';
import { NOTIFY_KINDS } from '#daemon/domain/operations/index.ts';
import type { SettingsForm } from '#lib/shared/forms.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';
import SwitchRow from '#components/ui/form/SwitchRow.vue';

defineProps<{ form: SettingsForm }>();
</script>

<template>
  <FieldSection id="settings-notifications" title="Notifications">
    <SwitchRow v-model="form.desktop" label="macOS notifications" />
    <FieldRow as="div" label="Tell me when">
      <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1.5">
        <label v-for="kind in NOTIFY_KINDS" :key="kind" class="flex items-center gap-2">
          <input type="checkbox" :value="kind" v-model="form.events" /> {{ NOTIFY_LABELS[kind] }}
        </label>
      </div>
    </FieldRow>
    <FieldRow
      label="ntfy topic"
      hint="Optional, for phone alerts. Task titles go to ntfy.sh, and anyone who knows the topic can read them, so pick something hard to guess."
    >
      <input v-model="form.ntfy_topic" class="max-w-sm" placeholder="e.g. agentdeck-7f3k2" />
    </FieldRow>
  </FieldSection>
</template>
