<script setup lang="ts">
import { computed } from 'vue';
import { openExternal } from '#platform/native.ts';
import { markdownHtml } from '#lib/shared/render.ts';

const props = defineProps<{ text: string; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ path: [path: string, line: number | null] }>();

const html = computed(() => markdownHtml(props.text, props.isPath));

function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.path) emit('path', a.dataset.path, a.dataset.line ? Number(a.dataset.line) : null);
  else if (a.href) openExternal(a.href);
}
</script>

<template>
  <div class="md" @click="onClick" v-html="html" />
</template>

<style>
@layer components {
  .md {
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .md > :first-child {
    margin-top: 0;
  }
  .md > :last-child {
    margin-bottom: 0;
  }
  .md h1,
  .md h2,
  .md h3,
  .md h4 {
    margin: 1.1em 0 0.4em;
    line-height: 1.3;
  }
  .md h1 {
    font-size: 1.45em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--border);
  }
  .md h2 {
    font-size: 1.2em;
    padding-bottom: 0.2em;
    border-bottom: 1px solid var(--border);
  }
  .md h3 {
    font-size: 1.05em;
  }
  .md p,
  .md ul,
  .md ol,
  .md pre,
  .md table,
  .md blockquote {
    margin: 0 0 0.75em;
  }
  .md ul,
  .md ol {
    padding-left: 1.6em;
  }
  .md code {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
    font-size: 0.9em;
  }
  .md pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    overflow-x: auto;
  }
  .md pre code {
    background: none;
    border: none;
    padding: 0;
  }
  .md blockquote {
    border-left: 3px solid var(--border);
    padding-left: 12px;
    color: var(--muted);
  }
  .md table {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  .md th,
  .md td {
    border: 1px solid var(--border);
    padding: 4px 10px;
  }
  .md a {
    color: var(--accent);
  }
  .md a.path code {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  }
  .md img {
    max-width: 100%;
  }
}
</style>
