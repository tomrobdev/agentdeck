// Reads a source tree with the TypeScript compiler: every file's AST and its imports, with target, line and type-only flag.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import ts from 'typescript';
import { REPO, packageOf, resolveAlias } from '#scripts/lib/imports.ts';

export interface Import {
  spec: string;
  target: string | null;
  line: number;
  typeOnly: boolean;
}

export interface Source {
  path: string;
  ast: ts.SourceFile;
  imports: Import[];
}

export function lineOf(ast: ts.SourceFile, node: ts.Node): number {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

export function vueScript(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/(<script\b[^>]*>)([^]*?)(<\/script>)/g)) {
    const start = m.index + m[1].length;
    out += blank(text.slice(last, start)) + m[2];
    last = start + m[2].length;
  }
  return out + blank(text.slice(last));
}

export function parseSource(path: string, text: string, root?: string): Source {
  const code = path.endsWith('.vue') ? vueScript(text) : text;
  const ast = ts.createSourceFile(path.replace(/\.vue$/, '.vue.ts'), code, ts.ScriptTarget.Latest, true);
  return { path, ast, imports: importsOf(path, ast, root) };
}

export function readSources(root: string, opts: { vue?: boolean } = {}): Source[] {
  const repoRoot = relative(REPO, root).split(sep).join('/');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') || (opts.vue && f.endsWith('.vue')))
    .sort()
    .map((path) => parseSource(path, readFileSync(join(root, path), 'utf8'), repoRoot));
}

export function targetOf(path: string, spec: string, root?: string): string | null {
  if (spec.startsWith('.')) return join(dirname(path), spec);
  if (!spec.startsWith('#')) return null;
  const hit = resolveAlias(spec, root ? packageOf(`${root}/`) : null);
  return hit && posix.relative(root ?? `${hit.alias.pkg}/src`, hit.path);
}

function importsOf(path: string, ast: ts.SourceFile, root?: string): Import[] {
  const out: Import[] = [];
  const add = (node: ts.Node, spec: ts.Node, typeOnly: boolean) => {
    if (!ts.isStringLiteral(spec)) return;
    out.push({ spec: spec.text, target: targetOf(path, spec.text, root), line: lineOf(ast, node), typeOnly });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allTypes =
        !!clause &&
        (clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.every((e) => e.isTypeOnly)));
      add(node, node.moduleSpecifier, allTypes);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const allTypes = node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly));
      add(node, node.moduleSpecifier, allTypes);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      add(node, node.arguments[0], false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

export function exportedNames(ast: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of ast.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) names.push(...stmt.exportClause.elements.map((e) => e.name.text));
      continue;
    }
    if (!ts.canHaveModifiers(stmt) || !ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(stmt))
      names.push(...stmt.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : [])));
    else if ('name' in stmt && stmt.name && ts.isIdentifier(stmt.name as ts.Node)) names.push((stmt.name as ts.Identifier).text);
  }
  return names;
}
