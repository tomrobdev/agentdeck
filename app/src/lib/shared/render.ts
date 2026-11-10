// Markdown and syntax highlighting. The only module that imports markdown-it, DOMPurify and highlight.js.
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';

const LANGUAGES = {
  bash,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

const BY_EXTENSION: Record<string, string> = {
  sh: 'bash',
  zsh: 'bash',
  bash: 'bash',
  css: 'css',
  scss: 'css',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  kt: 'kotlin',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  plist: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
};

export function languageFor(path: string): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return 'bash';
  return BY_EXTENSION[name.split('.').pop() ?? ''] ?? null;
}

export const isMarkdown = (path: string) => languageFor(path) === 'markdown';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(code: string, lang: string | null): string {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

export function highlightLines(lines: string[], lang: string | null): string[] {
  if (!lang || !hljs.getLanguage(lang)) return lines.map(escapeHtml);
  return splitHighlighted(highlight(lines.join('\n'), lang));
}

function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === '\n') {
      out.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else if (part.startsWith('<span')) {
      open.push(part);
      line += part;
    } else if (part === '</span>') {
      open.pop();
      line += part;
    } else line += part;
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (code, lang) => `<pre class="hljs"><code>${highlight(code, hljs.getLanguage(lang) ? lang : null)}</code></pre>`,
});

const PATH_LIKE = /^((?:[\w.@-]+\/)*[\w.@-]+\.\w+)(?::(\d+))?$/;

const codeInline = md.renderer.rules.code_inline!;
md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const html = codeInline(tokens, idx, options, env, self);
  const isPath = (env as { isPath?: (path: string) => boolean } | undefined)?.isPath;
  const m = tokens[idx].content.match(PATH_LIKE);
  if (!m || !isPath?.(m[1])) return html;
  const before = tokens.slice(0, idx);
  if (before.filter((t) => t.type === 'link_open').length > before.filter((t) => t.type === 'link_close').length) return html;
  return `<a class="path" href="#" data-path="${m[1]}" data-line="${m[2] ?? ''}">${html}</a>`;
};

export function markdownHtml(text: string, isPath?: (path: string) => boolean): string {
  return DOMPurify.sanitize(md.render(text, { isPath }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input'] });
}
