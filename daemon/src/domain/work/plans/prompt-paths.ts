// The repo paths a task's prompt tells the worker to read or follow.

const CREATORS = new Set([
  'add',
  'adds',
  'added',
  'create',
  'creates',
  'created',
  'creating',
  'new',
  'write',
  'writes',
  'generate',
  'make',
]);
const MOVERS = new Set([
  'move',
  'moves',
  'moved',
  'moving',
  'rename',
  'renames',
  'renamed',
  'renaming',
  'extract',
  'extracts',
  'extracted',
  'extracting',
  'split',
]);
const FILLER = new Set(['a', 'an', 'the', 'file', 'folder', 'directory', 'doc', 'called', 'named', 'at', 'as', 'under', 'in']);
const KNOWN_EXTENSIONS = new Set(
  'ts tsx mts cts js jsx mjs cjs json jsonc md mdx html htm css scss vue sql yml yaml toml sh zsh py rs go swift plist lock txt svg png jpg jpeg gif ico icns conf cfg ini xml csv log mjs'.split(
    ' ',
  ),
);

const TOKEN = /`([^`\n]+)`|[^\s`]+/g;
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,7})$/;

function asPath(raw: string, backticked: boolean): string | null {
  let token = backticked ? raw.trim() : raw.replace(/^[([{"'<]+/, '').replace(/[)\]}"',;:!?.>]+$/, '');
  token = token.replace(/#L\d+(?:-L?\d+)?$/, '').replace(/:\d+(?:[-:]\d+)*$/, '');
  if (/\s/.test(token) || /[*?{}[\]<>$|\\=@#]/.test(token)) return null;
  if (token.includes('://') || /^(www\.|mailto:)/.test(token)) return null;
  token = token.replace(/^\.\//, '');
  if (!token || token.startsWith('/') || token.startsWith('~') || token.startsWith('.git/') || token.split('/').includes('..')) return null;
  if (token.endsWith('/')) return /^[\w.-][\w./-]*$/.test(token) && token.replace(/\//g, '') !== '' ? token : null;
  if (!/^[\w.-][\w./-]*$/.test(token)) return null;
  const base = token.slice(token.lastIndexOf('/') + 1);
  const extension = EXTENSION.exec(base)?.[1];
  if (!extension) return null;
  if (!token.includes('/') && (!backticked || !KNOWN_EXTENSIONS.has(extension.toLowerCase()))) return null;
  return token;
}

function createdAt(text: string, at: number): boolean {
  const words = text
    .slice(0, at)
    .split('\n')
    .pop()!
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  let i = words.length - 1;
  while (i >= 0 && FILLER.has(words[i]) && words.length - 1 - i < 3) i--;
  if (i < 0) return false;
  if (CREATORS.has(words[i])) return true;
  return (words[i] === 'into' || words[i] === 'to') && words.slice(Math.max(0, i - 12), i).some((w) => MOVERS.has(w));
}

function prose(prompt: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return prompt
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/(\[[^\]\n]*\]\()([^)\s]+)\)/g, (_, head: string, target: string) => `${blank(head)}${target} `);
}

export function pathsNamedIn(prompt: string): string[] {
  const text = prose(prompt);
  const named: string[] = [];
  const created = new Set<string>();
  let carry = false;
  let previousEnd = 0;
  for (const m of text.matchAll(TOKEN)) {
    const path = asPath(m[1] ?? m[0], m[1] !== undefined);
    if (!path) continue;
    const makes: boolean = createdAt(text, m.index) || (carry && /^[\s,]*(?:and\s+)?$/i.test(text.slice(previousEnd, m.index)));
    if (makes) created.add(path);
    else named.push(path);
    carry = makes;
    previousEnd = m.index + m[0].length;
  }
  return [...new Set(named)].filter((p) => !created.has(p));
}

/** Where a named path is among a commit's files: as written, only under a subfolder, or nowhere. */
export type PathMatch = { kind: 'exact' } | { kind: 'under'; as: string } | { kind: 'missing' };

export function matchPath(named: string, files: readonly string[]): PathMatch {
  if (named.endsWith('/')) {
    if (files.some((f) => f.startsWith(named))) return { kind: 'exact' };
    const inner = `/${named}`;
    const hit = files.find((f) => f.includes(inner));
    return hit ? { kind: 'under', as: hit.slice(0, hit.indexOf(inner) + inner.length) } : { kind: 'missing' };
  }
  if (files.includes(named)) return { kind: 'exact' };
  const tail = `/${named}`;
  const hit = files.find((f) => f.endsWith(tail));
  return hit ? { kind: 'under', as: hit } : { kind: 'missing' };
}
