<script setup lang="ts">
import type { NotificationRow } from '#api/types.ts';
import { useSettingsForm } from '#composables/operations/useSettingsForm.ts';
import { isNative } from '#platform/native.ts';
import Modal from '#components/ui/Modal.vue';
import AppearanceSettings from '#components/operations/settings/AppearanceSettings.vue';
import BudgetSettings from '#components/operations/settings/BudgetSettings.vue';
import CommandSettings from '#components/operations/settings/CommandSettings.vue';
import DaemonSettings from '#components/operations/settings/DaemonSettings.vue';
import ModelSettings from '#components/operations/settings/ModelSettings.vue';
import NotificationSettings from '#components/operations/settings/NotificationSettings.vue';
import RecentAlerts from '#components/operations/settings/RecentAlerts.vue';

defineProps<{ notifications: NotificationRow[] }>();
const emit = defineEmits<{ close: [] }>();
const { form, service, failure, saving, tested, terminalCmd, editorCmd, appAtLogin, toggleAppAtLogin, save, test } = useSettingsForm(() =>
  emit('close'),
);
</script>

<template>
  <Modal title="Settings" @close="$emit('close')">
    <p v-if="!form && !failure" class="text-muted">Loading…</p>
    <form v-if="form" class="flex flex-col gap-[18px]" @submit.prevent="save()">
      <AppearanceSettings />
      <BudgetSettings :form="form" />
      <ModelSettings :form="form" />
      <DaemonSettings :form="form" :service="service" :app-at-login="appAtLogin" @toggle-app-at-login="toggleAppAtLogin" />
      <CommandSettings v-if="isNative" v-model:terminal="terminalCmd" v-model:editor="editorCmd" />
      <NotificationSettings :form="form" />
      <RecentAlerts :notifications="notifications" />

      <p v-if="failure" class="form-error">{{ failure }}</p>
      <div class="flex items-center gap-2">
        <button type="button" @click="test" :disabled="saving">Save &amp; send test</button>
        <span class="text-muted">{{ tested }}</span>
        <span class="spacer" />
        <button type="button" @click="$emit('close')">Cancel</button>
        <button class="primary" type="submit" :disabled="saving">Save</button>
      </div>
    </form>
    <p v-else-if="failure" class="form-error">{{ failure }}</p>
  </Modal>
</template>
