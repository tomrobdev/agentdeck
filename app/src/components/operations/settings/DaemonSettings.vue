<script setup lang="ts">
import type { ServiceStatus } from '#api/types.ts';
import type { SettingsForm } from '#lib/shared/forms.ts';
import { isNative } from '#platform/native.ts';
import Chip from '#components/ui/Chip.vue';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';
import SwitchRow from '#components/ui/form/SwitchRow.vue';
import Switch from '#components/ui/form/Switch.vue';

defineProps<{ form: SettingsForm; service: ServiceStatus | null; appAtLogin: boolean | null }>();
defineEmits<{ toggleAppAtLogin: [] }>();
</script>

<template>
  <FieldSection id="settings-daemon" title="Daemon">
    <FieldRow as="div" label="Runs at login">
      <Chip :tone="service?.state === 'running' ? 'done' : 'blocked'" variant="tint" dot>
        {{ service?.installed ? `Installed · ${service.state ?? 'not loaded'}` : 'Not installed' }}
      </Chip>
      <small v-if="!service?.installed" class="text-muted text-xs"
        >Run <code>agentdeck install</code> once and it starts at login and restarts if it dies.</small
      >
    </FieldRow>
    <SwitchRow
      v-model="form.reload_on_change"
      label="Restart on change"
      hint="For developing AgentDeck: once daemon/src changes and no task or planner run is active, it exits and launchd starts the new code."
    />
    <FieldRow v-if="isNative" as="div" label="Open at login" hint="This dashboard, in the menu bar. Applies at once.">
      <Switch :model-value="!!appAtLogin" label="Open this dashboard at login" @update:model-value="$emit('toggleAppAtLogin')" />
    </FieldRow>
  </FieldSection>
</template>
