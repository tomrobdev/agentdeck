<script setup lang="ts">
import type { NotificationRow } from '../../api/types';
import { useSettingsForm } from '../../composables/operations/useSettingsForm';
import { isNative } from '../../platform/native';
import Modal from '../ui/Modal.vue';
import AppearanceSettings from './settings/AppearanceSettings.vue';
import BudgetSettings from './settings/BudgetSettings.vue';
import CommandSettings from './settings/CommandSettings.vue';
import DaemonSettings from './settings/DaemonSettings.vue';
import ModelSettings from './settings/ModelSettings.vue';
import NotificationSettings from './settings/NotificationSettings.vue';
import RecentAlerts from './settings/RecentAlerts.vue';

// The settings in sections; the form's state and its save are in useSettingsForm.
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
