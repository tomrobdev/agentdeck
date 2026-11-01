// The repo paths a task's prompt tells the worker to read or follow. Pure: no I/O.
//
// A heuristic, not a parser. It finds:
// - text in backticks that is one path: `docs/plans/x.html`, `package.json`, `src/domain/`
// - bare words with a slash that end in a file extension or in "/": docs/plans/x.html, src/domain/
// and ignores URLs, globs, absolute and `..` paths, words without a slash outside backticks ("Node.js", "e.g."),
// and paths the prompt says to create (the words just before them: add, create, new, write ..., after "a", "the",
// "file" and the like). A trailing ":12" or ":12-20" line reference is dropped. It misses paths written as prose
// ("the plans folder") and skips a real path after a word like "add" ("add tests to src/x.ts" still names src/x.ts,
// but "add src/x.ts to the list" does not), which is the safe side: a missed path is no warning, not a false one.

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
const FILLER = new Set(['a', 'an', 'the', 'file', 'folder', 'directory', 'doc', 'called', 'named', 'at', 'as', 'under', 'in']);

const TOKEN = /`([^`\n]+)`|[^\s`]+/g;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** The path a token spells, or null if it isn't one. */
function asPath(raw: string, backticked: boolean): string | null {
  let token = backticked ? raw.trim() : raw.replace(/^[([{"'<]+/, '').replace(/[)\]}"',;:!?.>]+$/, '');
  token = token.replace(/:\d+(-\d+)?$/, '');
  if (/\s/.test(token) || /[*?{}[\]<>$|\\=@#]/.test(token)) return null;
  if (token.includes('://') || /^(www\.|mailto:)/.test(token)) return null;
  token = token.replace(/^\.\//, '');
  if (!token || token.startsWith('/') || token.startsWith('~') || token.startsWith('.git/') || token.split('/').includes('..')) return null;
  if (token.endsWith('/')) return /^[\w.-][\w./-]*$/.test(token) && token.replace(/\//g, '') !== '' ? token : null;
  if (!/^[\w.-][\w./-]*$/.test(token)) return null;
  const base = token.slice(token.lastIndexOf('/') + 1);
  if (!EXTENSION.test(base)) return null;
  // Outside backticks a bare file name is more likely a word ("Node.js"); a slash makes it a path.
  if (!backticked && !token.includes('/')) return null;
  return token;
}

/** Whether the words just before `at` say the prompt is making the thing that follows. */
function createdAt(prompt: string, at: number): boolean {
  const words = prompt
    .slice(0, at)
    .split('\n')
    .pop()!
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  let i = words.length - 1;
  while (i >= 0 && FILLER.has(words[i]) && words.length - 1 - i < 3) i--;
  return i >= 0 && CREATORS.has(words[i]);
}

/** Repo-relative paths the prompt names and expects to exist already, in order, once each. */
export function pathsNamedIn(prompt: string): string[] {
  const found: string[] = [];
  for (const m of prompt.matchAll(TOKEN)) {
    const path = asPath(m[1] ?? m[0], m[1] !== undefined);
    if (path && !found.includes(path) && !createdAt(prompt, m.index)) found.push(path);
  }
  return found;
}
