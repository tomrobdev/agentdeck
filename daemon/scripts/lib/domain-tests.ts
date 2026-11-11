// Every function a domain context's index.ts exports is called in at least one pure test: one that imports no db, application, adapters, fixtures, node:fs or node:child_process.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { projectOptions } from './strictness.ts';
import { type Source, parseSource } from './sources.ts';

const ROOT = join(import.meta.dirname, '../../..');
const DOMAIN = join(ROOT, 'daemon/src/domain');

export interface DomainExport {
  context: string;
  name: string;
  file: string;
}

export interface TestFile {
  path: string;
  source: Source;
}

export const exportKey = (e: DomainExport) => `${e.context}/${e.name}`;

const IMPURE_SPEC = /(^|\/)src\/(db|application|adapters)(\/|$)|(^|\/)fixtures(\/|$)|^(node:)?(fs|fs\/promises|child_process)$/;

export function impureImports(source: Source): string[] {
  return source.imports.filter((i) => IMPURE_SPEC.test(i.spec)).map((i) => i.spec);
}

export function readDomainFunctions(): DomainExport[] {
  const contexts = readdirSync(DOMAIN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const indexes = contexts.map((c) => join(DOMAIN, c, 'index.ts'));
  const program = ts.createProgram(indexes, projectOptions('daemon'));
  const checker = program.getTypeChecker();
  return contexts.flatMap((context, i) => {
    const sf = program.getSourceFile(indexes[i]);
    const module = sf && checker.getSymbolAtLocation(sf);
    if (!module) return [];
    return checker.getExportsOfModule(module).flatMap((symbol) => {
      const real = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const decl = real.declarations?.[0];
      if (!decl || !(real.flags & ts.SymbolFlags.Value)) return [];
      const callable =
        (real.flags & ts.SymbolFlags.Function) !== 0 || checker.getTypeOfSymbolAtLocation(real, decl).getCallSignatures().length > 0;
      if (!callable) return [];
      return [{ context, name: symbol.name, file: decl.getSourceFile().fileName.slice(ROOT.length + 1) }];
    });
  });
}

export function readTestFiles(): TestFile[] {
  const root = join(ROOT, 'daemon/test');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => ({ path: `daemon/test/${f}`, source: parseSource(f, readFileSync(join(root, f), 'utf8')) }));
}

export function domainNamesUsed(source: Source): Set<string> {
  const locals = new Map<string, string>();
  const spaces = new Set<string>();
  for (const stmt of source.ast.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly || !stmt.moduleSpecifier.text.includes('src/domain/')) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) spaces.add(bindings.name.text);
    else if (bindings) {
      for (const e of bindings.elements) if (!e.isTypeOnly) locals.set(e.name.text, (e.propertyName ?? e.name).text);
    }
  }
  const used = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const original = locals.get(node.text);
      if (original) used.add(original);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && spaces.has(node.expression.text)) {
      used.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source.ast);
  return used;
}

export function checkDomainTests(exports: DomainExport[], tests: TestFile[], allowed: string[]): { found: string[]; stale: string[] } {
  const tested = new Set(tests.filter((t) => !impureImports(t.source).length).flatMap((t) => [...domainNamesUsed(t.source)]));
  const missing = exports.filter((e) => !tested.has(e.name));
  const keys = new Set(exports.map(exportKey));
  return {
    found: missing
      .filter((e) => !allowed.includes(exportKey(e)))
      .map(
        (e) =>
          `${e.file}: ${e.name} (exported by domain/${e.context}) is called in no pure test: add one that imports it and nothing from db, application, adapters, fixtures, node:fs or node:child_process, or list "${exportKey(e)}" on UNTESTED_DOMAIN_EXPORTS (daemon/scripts/lib/progress.ts)`,
      ),
    stale: allowed
      .filter((k) => !keys.has(k) || !missing.some((e) => exportKey(e) === k))
      .map(
        (k) => `${k} is on UNTESTED_DOMAIN_EXPORTS but ${keys.has(k) ? 'has a pure test now' : 'is no longer exported'}: remove the entry`,
      ),
  };
}
