// rule:contexts. Each folder under domain/ is a bounded context with an `index.ts` of named exports. Everything outside the
// context (other contexts, the layers above, the dashboard) imports it only through that file.
import ts from 'typescript';
import { type Source, exportedNames } from './sources.ts';

/** The context a path under src/ belongs to (`domain/work/read/files.ts` is in `work`), or null outside domain/. */
export const contextOf = (path: string): string | null => path.match(/^domain\/([^/]+)\//)?.[1] ?? null;

/** The imports of a context's files from outside it that do not go through its `index.ts`, as `file:line` messages. */
export function checkContextImports(sources: Source[], dashboard: Source[] = []): string[] {
  const found: string[] = [];
  const check = (s: Source, own: string | null, toDomain: (target: string) => string | null) => {
    for (const i of s.imports) {
      const target = i.target && toDomain(i.target);
      const ctx = target && contextOf(target);
      if (!target || !ctx || ctx === own || target === `domain/${ctx}/index.ts`) continue;
      found.push(`${s.path}:${i.line} imports ${target}: import the ${ctx} context through domain/${ctx}/index.ts`);
    }
  };
  for (const s of sources) check(s, contextOf(s.path), (t) => t);
  // The dashboard reaches the daemon with paths such as ../../../daemon/src/domain/work/plan.ts.
  for (const s of dashboard)
    check(s, null, (t) => (t.includes('daemon/src/') ? t.slice(t.indexOf('daemon/src/') + 'daemon/src/'.length) : null));
  return found;
}

/** The contexts without an `index.ts`, and the index files that use `export *`, a default export or a declaration of their own. */
export function checkContextIndexes(sources: Source[]): string[] {
  const found: string[] = [];
  const contexts = new Set(sources.map((s) => contextOf(s.path)).filter((c): c is string => c !== null));
  for (const ctx of [...contexts].sort()) {
    const index = sources.find((s) => s.path === `domain/${ctx}/index.ts`);
    if (!index) {
      found.push(`domain/${ctx}/ has no index.ts: add one that re-exports what other contexts use, by name`);
      continue;
    }
    for (const stmt of index.ast.statements) {
      const ok = ts.isExportDeclaration(stmt) && !!stmt.moduleSpecifier && !!stmt.exportClause && ts.isNamedExports(stmt.exportClause);
      if (!ok)
        found.push(
          `${index.path}:${index.ast.getLineAndCharacterOfPosition(stmt.getStart(index.ast)).line + 1} must be \`export { … } from\` with named exports only`,
        );
    }
  }
  return found;
}

/** The names an index exports that nothing outside its context imports: remove them. */
export function checkUnusedIndexExports(sources: Source[], dashboard: Source[] = []): string[] {
  const found: string[] = [];
  const imported = new Map<string, Set<string>>();
  const note = (target: string, names: string[]) => imported.set(target, new Set([...(imported.get(target) ?? []), ...names]));
  for (const s of [...sources, ...dashboard]) {
    for (const stmt of s.ast.statements) {
      if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) continue;
      const spec = stmt.moduleSpecifier;
      if (!spec || !ts.isStringLiteral(spec) || !spec.text.endsWith('/index.ts')) continue;
      const own = contextOf(s.path);
      const hit = s.imports.find((i) => i.spec === spec.text);
      if (!hit?.target) continue;
      const target = hit.target.includes('daemon/src/')
        ? hit.target.slice(hit.target.indexOf('daemon/src/') + 'daemon/src/'.length)
        : hit.target;
      if (own && target.startsWith(`domain/${own}/`)) continue;
      const clause = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : stmt.exportClause;
      if (clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause)))
        note(
          target,
          clause.elements.map((e) => (e.propertyName ?? e.name).text),
        );
    }
  }
  for (const s of sources) {
    if (!/^domain\/[^/]+\/index\.ts$/.test(s.path)) continue;
    for (const name of exportedNames(s.ast)) {
      if (!imported.get(s.path)?.has(name)) found.push(`${s.path} exports ${name}, which nothing outside the context imports: remove it`);
    }
  }
  return found;
}
