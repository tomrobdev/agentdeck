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

/** The highlight.js language for a file path, or null to show it plain. */
export function languageFor(path: string): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile' || name === 'makefile') return 'bash';
  return BY_EXTENSION[name.split('.').pop() ?? ''] ?? null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Highlighted HTML for some code; plain escaped text when the language is unknown or it fails. */
export function highlight(code: string, lang: string | null): string {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Highlighted HTML per line, so line numbers and diff rows stay aligned. The text is highlighted as a
 * whole, which keeps multi-line strings and comments right, then split back into lines.
 */
export function highlightLines(lines: string[], lang: string | null): string[] {
  if (!lang || !hljs.getLanguage(lang)) return lines.map(escapeHtml);
  return splitHighlighted(highlight(lines.join('\n'), lang));
}

/** Split highlight.js HTML at newlines, closing and reopening spans so each line stands alone. */
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
  html: false, // agent-written markdown is untrusted; DOMPurify below is the second line
  linkify: true,
  breaks: false,
  highlight: (code, lang) => `<pre class="hljs"><code>${highlight(code, hljs.getLanguage(lang) ? lang : null)}</code></pre>`,
});

/** Sanitised HTML for markdown text. Remote images are blocked by the CSP anyway. */
export function markdownHtml(text: string): string {
  return DOMPurify.sanitize(md.render(text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input'] });
}
