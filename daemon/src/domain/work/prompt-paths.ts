// The repo paths a task's prompt tells the worker to read or follow. Pure: no I/O.
//
// A heuristic, not a parser. It finds:
// - text in backticks that is one path: `docs/plans/x.html`, `package.json`, `src/domain/`
// - bare words with a slash that end in a file extension or in "/": docs/plans/x.html, src/domain/
// - the target of a markdown link: [the plan](docs/plans/x.html)
// A name without a slash counts only with a known file extension (`package.json`, not `task.prompt`).
// It ignores fenced code, URLs, globs, absolute and `..` paths, words without a slash outside backticks ("Node.js",
// "e.g."), and paths the prompt creates: any path after add, create, new, write ... (after "a", "the", "file" and the
// like), after move, rename or extract ... into/to, or joined to such a path by "and" or ",". A path created anywhere
// in the prompt is skipped everywhere in it. A trailing "#L12", ":12", ":12-20" or ":12:5" is dropped. It misses paths
// written as prose ("the plans folder") and skips a real path after a word like "add" ("add tests to src/x.ts" still
// names src/x.ts, but "add src/x.ts to the list" does not), which is the safe side: a missed path is no warning,
// not a false one.

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
/** Verbs whose "into"/"to" target is made by the move. */
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

/** The path a token spells, or null if it isn't one. */
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
  // Outside backticks a bare file name is more likely a word ("Node.js"); a slash makes it a path.
  if (!token.includes('/') && (!backticked || !KNOWN_EXTENSIONS.has(extension.toLowerCase()))) return null;
  return token;
}

/** Whether the words just before `at` say the prompt is making the thing that follows. */
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

/** The prompt with fenced code blanked and each markdown link cut down to its target, keeping every position. */
function prose(prompt: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return prompt
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/(\[[^\]\n]*\]\()([^)\s]+)\)/g, (_, head: string, target: string) => `${blank(head)}${target} `);
}

/** Repo-relative paths the prompt names and expects to exist already, in order, once each. */
export function pathsNamedIn(prompt: string): string[] {
  const text = prose(prompt);
  const named: string[] = [];
  const created = new Set<string>();
  let carry = false; // the previous path was created and only "and" or "," came since
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

/** Look `named` (a file, or a folder with a trailing slash) up in `files` (every file path of a commit). */
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
