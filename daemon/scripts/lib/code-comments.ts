// Finds the code comments in the source, and which of them a tool reads and so may stay (rule:code-comments).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { vueScript } from './sources.ts';

export interface CodeComment {
  path: string;
  line: number;
  text: string;
}

export interface Violation extends CodeComment {
  why: string;
}

const ROOT = join(import.meta.dirname, '../../..');

export const COMMENT_ROOTS = ['daemon/src', 'app/src', 'daemon/test', 'daemon/scripts'];

const MIGRATIONS_FILE = 'daemon/src/db/schema.ts';

function kindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.mjs') || path.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function migrationComments(ast: ts.SourceFile): Set<number> {
  const positions = new Set<number>();
  const find = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'MIGRATIONS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements)
        for (const c of ts.getLeadingCommentRanges(ast.text, el.getFullStart()) ?? []) positions.add(c.pos);
    }
    ts.forEachChild(node, find);
  };
  find(ast);
  return positions;
}

function scriptComments(path: string, code: string): { comment: CodeComment; why: string | null }[] {
  const ast = ts.createSourceFile(path.replace(/\.vue$/, '.vue.ts'), code, ts.ScriptTarget.Latest, true, kindOf(path));
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const visit = (node: ts.Node) => {
    const children = node.getChildren(ast);
    if (!children.length) {
      const around = [
        ...(ts.getLeadingCommentRanges(code, node.getFullStart()) ?? []),
        ...(ts.getTrailingCommentRanges(code, node.getEnd()) ?? []),
      ];
      for (const c of around) {
        if (!seen.has(c.pos)) {
          seen.add(c.pos);
          ranges.push(c);
        }
      }
    }
    for (const child of children) visit(child);
  };
  visit(ast);
  ranges.sort((a, b) => a.pos - b.pos);
  const migrations = path === MIGRATIONS_FILE ? migrationComments(ast) : new Set<number>();
  const shebang = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
  return ranges.map((r, i) => {
    const text = code.slice(r.pos, r.end);
    const line = ast.getLineAndCharacterOfPosition(r.pos).line + 1;
    const comment = { path, line, text };
    if (migrations.has(r.pos)) return { comment, why: null };
    if (/^\/\/\/\s*<reference\s/.test(text)) return { comment, why: null };
    if (/^\/\/\s*@ts-expect-error\s+\S/.test(text)) return { comment, why: null };
    if (/^\/\/\s*@ts-expect-error\s*$/.test(text)) return { comment, why: '@ts-expect-error needs a reason after it' };
    const first = i === 0 && code.slice(shebang, r.pos).trim() === '';
    if (first && r.kind === ts.SyntaxKind.SingleLineCommentTrivia) return { comment, why: null };
    return { comment, why: 'a code comment outside the allowed kinds' };
  });
}

function templateComments(path: string, text: string): CodeComment[] {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const markup = text.replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/g, blank);
  const found: CodeComment[] = [];
  for (const m of markup.matchAll(/<!--[^]*?-->/g)) {
    found.push({ path, line: markup.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return found;
}

/** The code comments of one file that no tool reads: the file's leading one-line comment, a `@ts-expect-error` with its reason, a triple-slash reference, a shebang and a migration step's heading stay. */
export function commentViolations(path: string, text: string): Violation[] {
  const script = path.endsWith('.vue') ? vueScript(text) : text;
  const out: Violation[] = scriptComments(path, script)
    .filter((c) => c.why !== null)
    .map((c) => ({ ...c.comment, why: c.why as string }));
  if (path.endsWith('.vue'))
    out.push(...templateComments(path, text).map((c) => ({ ...c, why: 'a template comment is a code comment too' })));
  return out.sort((a, b) => a.line - b.line);
}

export function readViolations(roots: string[] = COMMENT_ROOTS): Violation[] {
  const found: Violation[] = [];
  for (const root of roots) {
    const files = readdirSync(join(ROOT, root), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|vue|mjs)$/.test(f) && !f.split('/').includes('node_modules'))
      .sort();
    for (const f of files) {
      const path = `${root}/${f}`;
      found.push(...commentViolations(path, readFileSync(join(ROOT, path), 'utf8')));
    }
  }
  return found;
}
