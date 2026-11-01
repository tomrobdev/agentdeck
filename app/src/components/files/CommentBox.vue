<script setup lang="ts">
import { onMounted, ref } from 'vue';

// The inline box for a new line comment. Save adds a draft comment; Escape or Cancel closes the box.
const props = defineProps<{ save: (body: string) => Promise<boolean> }>();
const emit = defineEmits<{ close: [] }>();

const body = ref('');
const box = ref<HTMLTextAreaElement | null>(null);
onMounted(() => box.value?.focus());
const saving = ref(false);
async function submit() {
  const text = body.value.trim();
  if (!text || saving.value) return;
  saving.value = true;
  const ok = await props.save(text);
  saving.value = false;
  if (ok) emit('close');
}
</script>

<template>
  <div class="my-1.5 rounded-md border border-border bg-panel p-2 font-sans whitespace-normal">
    <textarea
      ref="box"
      v-model="body"
      class="w-full resize-y"
      rows="3"
      placeholder="Leave a comment"
      @keydown.esc.stop="emit('close')"
      @keydown.enter.meta.prevent.stop="submit"
      @keydown.enter.ctrl.prevent.stop="submit"
    />
    <div class="mt-1.5 flex justify-end gap-1.5">
      <button @click="emit('close')">Cancel</button>
      <button class="primary" :disabled="!body.trim() || saving" @click="submit">Save</button>
    </div>
  </div>
</template>
