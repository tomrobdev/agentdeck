<script setup lang="ts">
import { CMUX_TEMPLATE, EDITOR_PRESETS } from '#lib/runs/terminal.ts';
import FieldRow from '#components/ui/form/FieldRow.vue';
import FieldSection from '#components/ui/form/FieldSection.vue';

const terminal = defineModel<string>('terminal', { required: true });
const editor = defineModel<string>('editor', { required: true });
</script>

<template>
  <FieldSection id="settings-commands" title="Terminal and editor" hint="Remembered on this computer.">
    <FieldRow label="Terminal command">
      <template #hint>
        Split on spaces ("quotes" keep spaces together) and run without a shell. <code>{title}</code>, <code>{cwd}</code> and
        <code>{command}</code> are filled in. cmux is found even though it is not on the app's PATH.
      </template>
      <input v-model="terminal" class="font-mono" spellcheck="false" />
      <button type="button" :disabled="terminal === CMUX_TEMPLATE" @click="terminal = CMUX_TEMPLATE">Use cmux</button>
    </FieldRow>
    <FieldRow label="Editor command">
      <template #hint>
        Opens a task's worktree, with <code>{cwd}</code> filled in. Empty hides the task's "open in editor" button.
      </template>
      <input v-model="editor" class="font-mono" spellcheck="false" placeholder="not set" />
      <span class="flex flex-wrap gap-2">
        <button v-for="p in EDITOR_PRESETS" :key="p.name" type="button" :disabled="editor === p.template" @click="editor = p.template">
          {{ p.name }}
        </button>
      </span>
    </FieldRow>
  </FieldSection>
</template>
