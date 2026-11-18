<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ sections: { id: string; label: string }[]; scroller: HTMLElement }>();
const active = ref(props.sections[0]?.id ?? '');
const NEAR_TOP_PX = 24;

let targets: { id: string; el: HTMLElement }[] = [];
let frame = 0;

function track() {
  frame = 0;
  const box = props.scroller;
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
    active.value = targets.at(-1)?.id ?? active.value;
    return;
  }
  const top = box.getBoundingClientRect().top + NEAR_TOP_PX;
  active.value = targets.findLast((t) => t.el.getBoundingClientRect().top <= top)?.id ?? targets[0]?.id ?? '';
}

function onScroll() {
  if (!frame) frame = requestAnimationFrame(track);
}

function go(id: string) {
  targets.find((t) => t.id === id)?.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  active.value = id;
}

onMounted(() => {
  targets = props.sections.flatMap((s) => {
    const el = props.scroller.querySelector<HTMLElement>(`#${s.id}`);
    return el ? [{ id: s.id, el }] : [];
  });
  props.scroller.addEventListener('scroll', onScroll, { passive: true });
  track();
});
onBeforeUnmount(() => {
  props.scroller.removeEventListener('scroll', onScroll);
  cancelAnimationFrame(frame);
});
</script>

<template>
  <nav aria-label="Settings sections" class="flex flex-col gap-0.5">
    <button
      v-for="s in sections"
      :key="s.id"
      type="button"
      class="side-nav-item"
      :class="active === s.id ? 'font-semibold' : 'text-muted'"
      :aria-current="active === s.id ? 'true' : undefined"
      @click="go(s.id)"
    >
      {{ s.label }}
    </button>
  </nav>
</template>
