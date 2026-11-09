<script setup lang="ts">
import { CMUX_TEMPLATE, EDITOR_PRESETS } from '../../../lib/runs/terminal';

// The commands that open a terminal and an editor, kept on this computer (the app only).
const terminal = defineModel<string>('terminal', { required: true });
const editor = defineModel<string>('editor', { required: true });
</script>

<template>
  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Terminal</h4>
    <label class="field">
      <span>Command that opens a terminal</span>
      <input v-model="terminal" class="font-mono" spellcheck="false" />
      <small class="text-muted text-xs">
        Split into arguments on spaces ("quotes" keep spaces together) and run without a shell. <code>{title}</code>, <code>{cwd}</code> and
        <code>{command}</code> are filled in; without a command, <code>{command}</code> and the flag before it are left out. cmux is found
        even though it is not on the app's PATH. Remembered on this computer.
      </small>
    </label>
    <button type="button" class="self-start" :disabled="terminal === CMUX_TEMPLATE" @click="terminal = CMUX_TEMPLATE">Use cmux</button>
  </section>

  <section class="flex flex-col gap-2.5">
    <h4 class="m-0">Editor</h4>
    <label class="field">
      <span>Command that opens a task's worktree in your editor</span>
      <input v-model="editor" class="font-mono" spellcheck="false" placeholder="not set" />
      <small class="text-muted text-xs">
        Run like the terminal command, with <code>{cwd}</code> filled in. Leave it empty and the task's "open in editor" button is hidden.
        Remembered on this computer.
      </small>
    </label>
    <div class="flex flex-wrap gap-2">
      <button v-for="p in EDITOR_PRESETS" :key="p.name" type="button" :disabled="editor === p.template" @click="editor = p.template">
        {{ p.name }}
      </button>
    </div>
  </section>
</template>
