// Finds the relative imports in the daemon's and the app's code, and rewrites each to the # subpath import of its folder.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { REPO, aliasFor, packageOf, resolveAlias } from '#scripts/lib/imports.ts';
import { lineOf, vueScript } from '#scripts/lib/sources.ts';

export const SCANNED_ROOTS = ['daemon/src', 'daemon/test', 'daemon/scripts', 'app/src', 'app/e2e'];

const SCANNED_FILE = /\.(ts|mts|mjs|vue)$/;

export interface RelativeImport {
  spec: string;
  line: number;
  start: number;
  end: number;
  fix: string | null;
}

export function scannedFiles(): string[] {
  return SCANNED_ROOTS.flatMap((root) =>
    readdirSync(join(REPO, root), { recursive: true, encoding: 'utf8' })
      .filter((f) => SCANNED_FILE.test(f) && !f.split('/').includes('node_modules'))
      .map((f) => `${root}/${f}`),
  ).sort();
}

const isRelative = (spec: string) => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

const isFile = (repoPath: string) => existsSync(join(REPO, repoPath)) && statSync(join(REPO, repoPath)).isFile();

function withExtension(target: string): string | null {
  const [path, query] = target.split(/(?=\?)/);
  if (isFile(path)) return target;
  const found = ['.ts', '/index.ts'].map((ext) => path + ext).find(isFile);
  return found ? found + (query ?? '') : null;
}

function localImports(repoPath: string, text: string): RelativeImport[] {
  const code = repoPath.endsWith('.vue') ? vueScript(text) : text;
  const ast = ts.createSourceFile(repoPath.replace(/\.vue$/, '.vue.ts'), code, ts.ScriptTarget.Latest, true);
  const pkg = packageOf(repoPath);
  const out: RelativeImport[] = [];
  const add = (node: ts.Node, spec: ts.Node | undefined) => {
    if (!spec || !ts.isStringLiteral(spec)) return;
    const relative = isRelative(spec.text);
    const target = relative
      ? posix.normalize(posix.join(posix.dirname(repoPath), spec.text))
      : spec.text.startsWith('#') && pkg
        ? (resolveAlias(spec.text, pkg)?.path ?? null)
        : null;
    if (!target || !pkg) {
      if (relative) out.push({ spec: spec.text, line: lineOf(ast, node), start: 0, end: 0, fix: null });
      return;
    }
    const named = withExtension(target) ?? (relative ? target : null);
    const fix = named && aliasFor(named, pkg);
    if (!relative && (!fix || fix === spec.text)) return;
    out.push({ spec: spec.text, line: lineOf(ast, node), start: spec.getStart(ast) + 1, end: spec.getEnd() - 1, fix });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

export const relativeImports = (repoPath: string, text: string): RelativeImport[] =>
  localImports(repoPath, text).filter((r) => isRelative(r.spec));

export function fixImports(repoPath: string, text: string): { text: string; unfixed: RelativeImport[] } {
  const found = localImports(repoPath, text);
  let out = text;
  for (const r of [...found].sort((a, b) => b.start - a.start)) {
    if (r.fix) out = out.slice(0, r.start) + r.fix + out.slice(r.end);
  }
  return { text: out, unfixed: found.filter((r) => !r.fix) };
}
