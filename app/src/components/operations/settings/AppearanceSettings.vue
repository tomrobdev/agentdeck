<script setup lang="ts">
import { MODES, THEMES, mode, setMode, setTheme, theme } from '../../../platform/theme';
import { approveDialogSetting, setApproveDialogSetting } from '../../../composables/work/useApprovals';
import { APPROVE_DIALOG_SETTINGS, asApproveDialogSetting } from '../../../lib/work/approve-dialog';
import RadioGroup from '../../ui/form/RadioGroup.vue';
import SegmentedControl from '../../ui/form/SegmentedControl.vue';

// How the dashboard looks and asks, both applied as you pick and remembered on this computer: nothing here is in the form.
</script>

<template>
  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Appearance</h4>
    <p class="text-muted m-0 text-sm">Applies as you pick, and is remembered on this computer.</p>
    <RadioGroup
      cards
      label="Theme"
      :options="THEMES.map((t) => ({ key: t.key, label: t.label, hint: t.hint }))"
      :model-value="theme"
      @update:model-value="setTheme"
    />
    <SegmentedControl
      class="self-start"
      label="Mode"
      :options="MODES.map((m) => ({ value: m.key, label: m.label }))"
      :model-value="mode"
      @update:model-value="setMode"
    />
  </section>

  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Approving</h4>
    <p class="text-muted m-0 text-sm">
      Open a dialog before approving, with how far main has moved, notes and overlaps, and a place to edit each prompt. Applies as you pick,
      and is remembered on this computer.
    </p>
    <SegmentedControl
      class="self-start"
      label="Approve dialog"
      :options="APPROVE_DIALOG_SETTINGS.map((s) => ({ value: s.key, label: s.label }))"
      :model-value="approveDialogSetting"
      @update:model-value="(v) => setApproveDialogSetting(asApproveDialogSetting(v))"
    />
  </section>
</template>
