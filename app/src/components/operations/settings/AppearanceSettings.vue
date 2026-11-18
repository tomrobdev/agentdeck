<script setup lang="ts">
import { MODES, THEMES, mode, setMode, setTheme, theme } from '#platform/theme.ts';
import { approveDialogSetting, setApproveDialogSetting } from '#composables/work/useApprovals.ts';
import { APPROVE_DIALOG_SETTINGS, asApproveDialogSetting } from '#lib/work/approve-dialog.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';
import RadioGroup from '#components/ui/form/RadioGroup.vue';
import SegmentedControl from '#components/ui/form/SegmentedControl.vue';
</script>

<template>
  <FieldSection id="settings-appearance" title="Appearance" hint="Remembered on this computer." instant>
    <FieldRow as="div" label="Theme">
      <RadioGroup
        cards
        label="Theme"
        :options="THEMES.map((t) => ({ key: t.key, label: t.label, hint: t.hint }))"
        :model-value="theme"
        @update:model-value="setTheme"
      />
    </FieldRow>
    <FieldRow as="div" label="Mode">
      <SegmentedControl
        label="Mode"
        :options="MODES.map((m) => ({ value: m.key, label: m.label }))"
        :model-value="mode"
        @update:model-value="setMode"
      />
    </FieldRow>
    <FieldRow
      as="div"
      label="Approve dialog"
      hint="A dialog before approving, with how far main has moved, notes and overlaps, and a place to edit each prompt."
    >
      <SegmentedControl
        label="Approve dialog"
        :options="APPROVE_DIALOG_SETTINGS.map((s) => ({ value: s.key, label: s.label }))"
        :model-value="approveDialogSetting"
        @update:model-value="(v) => setApproveDialogSetting(asApproveDialogSetting(v))"
      />
    </FieldRow>
  </FieldSection>
</template>
