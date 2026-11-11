// Counting the code comment lines a branch adds, and the repo's limits on them.
import type { Repo } from '../../repos/index.ts';
import { plural, wholeNumberError } from '../../shared/index.ts';

/** The lines a diff adds, per path. */
export type AddedLines = Record<string, string[]>;

/** The code comment lines a diff adds. */
export interface CodeCommentCount {
  /** Each file that adds a code comment line, with how many. */
  files: { path: string; lines: number }[];
  /** Code comment lines added in all. */
  lines: number;
  /** Non-blank lines added to the files the syntax table knows, prose files left out. */
  added: number;
  /** `lines` as a share of `added`, from 0 to 100. */
  percent: number;
}

interface Syntax {
  line: string[];
  blocks: [string, string][];
  starLines?: boolean;
}

const C_LIKE: Syntax = { line: ['//'], blocks: [['/*', '*/']], starLines: true };
const WITH_MARKUP: Syntax = {
  line: ['//'],
  blocks: [
    ['/*', '*/'],
    ['<!--', '-->'],
  ],
  starLines: true,
};
const HASH: Syntax = { line: ['#'], blocks: [] };
const SQL: Syntax = { line: ['--'], blocks: [['/*', '*/']], starLines: true };
const LUA: Syntax = { line: ['--'], blocks: [['--[[', ']]']] };
const SEMICOLON: Syntax = { line: [';'], blocks: [] };
const MARKUP: Syntax = { line: [], blocks: [['<!--', '-->']] };

const SYNTAX_OF: [string[], Syntax][] = [
  [['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'], C_LIKE],
  [['rs', 'go', 'swift', 'kt', 'kts', 'java', 'scala', 'dart'], C_LIKE],
  [['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'm', 'mm', 'cs'], C_LIKE],
  [['vue', 'svelte'], WITH_MARKUP],
  [['py', 'pyi', 'rb', 'sh', 'bash', 'zsh', 'fish', 'yaml', 'yml', 'toml', 'pl', 'r'], HASH],
  [['sql'], SQL],
  [['lua'], LUA],
  [['ini', 'clj', 'cljs', 'el', 'lisp', 'scm', 'asm'], SEMICOLON],
  [['html', 'htm', 'xml', 'svg'], MARKUP],
];

const PROSE = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc']);

const TRAILING = ['//', '#'];

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const isProse = (path: string, ext: string): boolean =>
  PROSE.has(ext) || ((ext === 'html' || ext === 'htm') && (path.startsWith('docs/') || path.includes('/docs/')));

function syntaxOf(path: string): Syntax | null {
  const ext = extensionOf(path);
  if (!ext || isProse(path, ext)) return null;
  return SYNTAX_OF.find(([exts]) => exts.includes(ext))?.[1] ?? null;
}

const isToolDirective = (text: string): boolean => text.startsWith('#!') || /^\/\/\s*@ts-expect-error\b/.test(text);

function hasTrailing(text: string, syntax: Syntax): boolean {
  return TRAILING.some((marker) => syntax.line.includes(marker) && new RegExp(`\\s${marker}(\\s|$)`).test(text));
}

function countFile(lines: string[], syntax: Syntax): { comments: number; added: number } {
  let comments = 0;
  let added = 0;
  let closing: string | null = null;
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    added++;
    if (closing) {
      comments++;
      if (text.includes(closing)) closing = null;
      continue;
    }
    const block = syntax.blocks.find(([open]) => text.startsWith(open));
    if (block) {
      comments++;
      if (!text.slice(block[0].length).includes(block[1])) closing = block[1];
    } else if (isToolDirective(text)) continue;
    else if (syntax.line.some((marker) => text.startsWith(marker))) comments++;
    else if (syntax.starLines && /^\*(\s|\/|$)/.test(text)) comments++;
    else if (hasTrailing(text, syntax)) comments++;
  }
  return { comments, added };
}

export function countCodeComments(added: AddedLines): CodeCommentCount {
  const files: { path: string; lines: number }[] = [];
  let total = 0;
  let lines = 0;
  for (const [path, fileLines] of Object.entries(added)) {
    const syntax = syntaxOf(path);
    if (!syntax) continue;
    const { comments, added: count } = countFile(fileLines, syntax);
    total += count;
    lines += comments;
    if (comments) files.push({ path, lines: comments });
  }
  return { files, lines, added: total, percent: total ? (lines / total) * 100 : 0 };
}

export const DEFAULT_CODE_COMMENT_MAX_LINES = 5;
export const DEFAULT_CODE_COMMENT_MAX_PERCENT = 5;

export type CodeCommentLimits = Pick<Repo, 'code_comment_max_lines' | 'code_comment_max_percent'>;

export function codeCommentsOver(count: Pick<CodeCommentCount, 'lines' | 'percent'>, limits: CodeCommentLimits): boolean {
  const { code_comment_max_lines: maxLines, code_comment_max_percent: maxPercent } = limits;
  return (maxLines > 0 && count.lines > maxLines) || (maxPercent > 0 && count.percent > maxPercent);
}

export const codeCommentLimitOn = (limits: CodeCommentLimits): boolean =>
  limits.code_comment_max_lines > 0 || limits.code_comment_max_percent > 0;

export function codeCommentLimitText(limits: CodeCommentLimits): string {
  const { code_comment_max_lines: maxLines, code_comment_max_percent: maxPercent } = limits;
  return [maxLines > 0 ? plural(maxLines, 'line') : null, maxPercent > 0 ? `${maxPercent}%` : null].filter(Boolean).join(' or ');
}

export function codeCommentsText(count: Pick<CodeCommentCount, 'lines' | 'percent'>, limits: CodeCommentLimits): string {
  const side = codeCommentsOver(count, limits) ? 'over' : 'within';
  return `${plural(count.lines, 'code comment line')} added (${Math.round(count.percent)}%), ${side} the limit of ${codeCommentLimitText(limits)}`;
}

export const codeCommentsTag = (count: Pick<CodeCommentCount, 'lines' | 'percent'>): string =>
  `code comments +${count.lines} (${Math.round(count.percent)}%)`;

export const codeCommentMaxLinesError = (value: unknown): string | null => wholeNumberError('code_comment_max_lines', value, 0, 10_000);

export const codeCommentMaxPercentError = (value: unknown): string | null => wholeNumberError('code_comment_max_percent', value, 0, 100);

export function parseAddedLines(diff: string): AddedLines {
  const added: AddedLines = {};
  let path: string | null = null;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      path = null;
    } else if (inHeader && line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t$/, '');
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
    } else if (line.startsWith('@@')) inHeader = false;
    else if (!inHeader && path !== null && line.startsWith('+')) (added[path] ??= []).push(line.slice(1));
  }
  return added;
}
