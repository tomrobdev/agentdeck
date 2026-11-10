// The use cases that start claude, the CLI's calls to them and to the daemon, and who builds an App, read with the TypeScript checker.
import { join, relative } from 'node:path';
import ts from 'typescript';

const DAEMON = join(import.meta.dirname, '../..');
const SRC = join(DAEMON, 'src');
const AGENT_PORT = { path: 'application/ports/agent.ts', iface: 'Agent', method: 'run' };
const APP_TYPES = { path: 'application/ports/app.ts', names: new Set(['App', 'ComposedApp', 'Ports']) };
const DAEMON_CLIENT = 'cli/operations/daemon-client.ts';
const ROUTE_HELPER = 'api/http.ts';

export interface Starter {
  path: string;
  name: string;
  line: number;
  useCase: boolean;
}

export interface Finding {
  path: string;
  line: number;
  message: string;
}

export function loadProgram(overlay: Record<string, string> = {}, old?: ts.Program): ts.Program {
  const configPath = join(DAEMON, 'tsconfig.json');
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, DAEMON);
  const files = Object.fromEntries(Object.entries(overlay).map(([path, text]) => [join(DAEMON, path), text]));
  const host = ts.createCompilerHost(config.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name in files ? ts.createSourceFile(name, files[name], lang, true) : getSourceFile(name, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name in files || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => files[name] ?? readFile(name);
  return ts.createProgram({ rootNames: [...config.fileNames, ...Object.keys(files)], options: config.options, host, oldProgram: old });
}

const srcPath = (file: ts.SourceFile) => relative(SRC, file.fileName);
const inSrc = (file: ts.SourceFile) => !relative(SRC, file.fileName).startsWith('..');
const lineAt = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const isApplication = (file: ts.SourceFile) => inSrc(file) && srcPath(file).startsWith('application/');

function isUnit(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return ts.isSourceFile(node.parent);
  if (ts.isVariableDeclaration(node)) return ts.isVariableDeclarationList(node.parent) && ts.isSourceFile(node.parent.parent.parent);
  return ts.isClassElement(node) && ts.isClassDeclaration(node.parent) && ts.isSourceFile(node.parent.parent);
}

function unitOf(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (isUnit(n)) return n;
  return undefined;
}

function unitName(unit: ts.Node): string {
  const own =
    (ts.isClassElement(unit) || ts.isClassDeclaration(unit) || ts.isFunctionDeclaration(unit) || ts.isVariableDeclaration(unit)) &&
    unit.name;
  const name = own ? own.getText() : 'constructor';
  const owner = ts.isClassElement(unit) && ts.isClassDeclaration(unit.parent) ? unit.parent.name : undefined;
  return owner ? `${owner.text}.${name}` : name;
}

function targetsOf(checker: ts.TypeChecker, node: ts.Node): ts.Declaration[] {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations ?? [];
}

function isImportName(node: ts.Node): boolean {
  const p = node.parent;
  return (
    ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isImportEqualsDeclaration(p)
  );
}

function eachIdentifier(file: ts.SourceFile, visit: (id: ts.Identifier) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isImportName(node)) visit(node);
    ts.forEachChild(node, walk);
  };
  walk(file);
}

function isAgentStart(decl: ts.Declaration): boolean {
  const iface = decl.parent;
  return (
    ts.isMethodSignature(decl) &&
    decl.name.getText() === AGENT_PORT.method &&
    ts.isInterfaceDeclaration(iface) &&
    iface.name.text === AGENT_PORT.iface &&
    srcPath(decl.getSourceFile()) === AGENT_PORT.path
  );
}

const starterCache = new WeakMap<ts.Program, Map<ts.Node, Starter>>();

function starterUnits(program: ts.Program): Map<ts.Node, Starter> {
  const cached = starterCache.get(program);
  if (cached) return cached;
  const checker = program.getTypeChecker();
  const callers = new Map<ts.Node, Set<ts.Node>>();
  const roots = new Set<ts.Node>();
  for (const file of program.getSourceFiles().filter(isApplication)) {
    eachIdentifier(file, (id) => {
      const owner = unitOf(id);
      if (!owner) return;
      for (const decl of targetsOf(checker, id)) {
        if (isAgentStart(decl)) roots.add(owner);
        if (!isApplication(decl.getSourceFile())) continue;
        const target = ts.isClassDeclaration(decl) ? (decl.members.find(ts.isConstructorDeclaration) ?? decl) : unitOf(decl);
        if (!target || target === owner) continue;
        if (!callers.has(target)) callers.set(target, new Set());
        callers.get(target)!.add(owner);
      }
    });
  }
  const reached = new Set<ts.Node>(roots);
  const queue = [...roots];
  while (queue.length) {
    const unit = queue.pop()!;
    const parents = [unit, ...(ts.isConstructorDeclaration(unit) ? [unit.parent] : [])];
    for (const p of parents)
      for (const caller of callers.get(p) ?? []) {
        if (reached.has(caller)) continue;
        reached.add(caller);
        queue.push(caller);
      }
  }
  const out = new Map<ts.Node, Starter>();
  for (const unit of reached)
    out.set(unit, { path: srcPath(unit.getSourceFile()), name: unitName(unit), line: lineAt(unit), useCase: !ts.isClassElement(unit) });
  starterCache.set(program, out);
  return out;
}

export function claudeStarters(program: ts.Program): Starter[] {
  return [...starterUnits(program).values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function startersNamedAt(program: ts.Program, node: ts.Node): Starter[] {
  const units = starterUnits(program);
  const checker = program.getTypeChecker();
  return targetsOf(checker, node).flatMap((decl) => {
    const unit = ts.isClassDeclaration(decl) ? decl : unitOf(decl);
    const found = unit && units.get(unit);
    return found ? [found] : [];
  });
}

const isCliFile = (file: ts.SourceFile) => inSrc(file) && (srcPath(file).startsWith('cli/') || srcPath(file) === 'cli.ts');

export function cliStarterCalls(program: ts.Program): Finding[] {
  const found: Finding[] = [];
  for (const file of program.getSourceFiles().filter(isCliFile)) {
    if (srcPath(file) === DAEMON_CLIENT) continue;
    eachIdentifier(file, (id) => {
      for (const s of startersNamedAt(program, id))
        found.push({
          path: srcPath(file),
          line: lineAt(id),
          message: `calls ${s.name} (${s.path}:${s.line}), which starts claude: send it to the daemon through ${DAEMON_CLIENT}`,
        });
    });
  }
  return found;
}

function callsTo(program: ts.Program, path: string, name: string, files: (f: ts.SourceFile) => boolean): ts.CallExpression[] {
  const checker = program.getTypeChecker();
  const out: ts.CallExpression[] = [];
  for (const file of program.getSourceFiles().filter(files)) {
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        targetsOf(checker, node.expression).some(
          (d) =>
            (ts.isFunctionDeclaration(d) || ts.isVariableDeclaration(d)) &&
            d.name?.getText() === name &&
            srcPath(d.getSourceFile()) === path,
        )
      )
        out.push(node);
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  return out;
}

function samplePath(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `1${s.literal.text}`).join('');
  return null;
}

function regexOf(node: ts.Expression): RegExp | null {
  if (!ts.isRegularExpressionLiteral(node)) return null;
  const end = node.text.lastIndexOf('/');
  return new RegExp(node.text.slice(1, end), node.text.slice(end + 1));
}

export function daemonRequestsWithoutClaude(program: ts.Program): Finding[] {
  const routes = callsTo(program, ROUTE_HELPER, 'route', (f) => inSrc(f) && srcPath(f).startsWith('api/routes/')).flatMap((call) => {
    const [method, pattern, handler] = call.arguments;
    const regex = pattern && regexOf(pattern);
    return method && ts.isStringLiteral(method) && regex && handler ? [{ method: method.text, regex, handler, call }] : [];
  });
  const found: Finding[] = [];
  for (const call of callsTo(program, DAEMON_CLIENT, 'callDaemon', isCliFile)) {
    const [method, pathArg] = call.arguments;
    const path = pathArg && samplePath(pathArg);
    const verb = method && ts.isStringLiteral(method) ? method.text : null;
    const at = { path: srcPath(call.getSourceFile()), line: lineAt(call) };
    if (!verb || !path) {
      found.push({ ...at, message: 'calls the daemon with a method or path that is not a literal, so its route cannot be read' });
      continue;
    }
    const route = routes.find((r) => r.method === verb && r.regex.test(path));
    if (!route) {
      found.push({ ...at, message: `sends ${verb} ${path}, which no route in api/routes/ answers` });
      continue;
    }
    const starts: Starter[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) starts.push(...startersNamedAt(program, node).filter((s) => s.useCase));
      ts.forEachChild(node, walk);
    };
    walk(route.handler);
    if (!starts.length)
      found.push({
        ...at,
        message: `sends ${verb} ${path}, whose route (${srcPath(route.call.getSourceFile())}:${lineAt(route.call)}) starts no claude: call its use case in the CLI's own process`,
      });
  }
  return found;
}

function namesAppType(checker: ts.TypeChecker, type: ts.Type | undefined): boolean {
  if (type?.isIntersection()) return type.types.some((t) => namesAppType(checker, t));
  const symbols = [type?.aliasSymbol, type?.getSymbol()].filter((s): s is ts.Symbol => !!s);
  return symbols.some(
    (s) =>
      APP_TYPES.names.has(s.name) &&
      (s.declarations ?? []).some((d) => inSrc(d.getSourceFile()) && srcPath(d.getSourceFile()) === APP_TYPES.path),
  );
}

export function appBuilders(program: ts.Program, allowed: (path: string) => boolean): Finding[] {
  const checker = program.getTypeChecker();
  const found: Finding[] = [];
  for (const file of program.getSourceFiles()) {
    const path = relative(DAEMON, file.fileName);
    if (file.isDeclarationFile || path.startsWith('..') || path.includes('node_modules') || allowed(path)) continue;
    const walk = (node: ts.Node): void => {
      const built =
        (ts.isObjectLiteralExpression(node) && namesAppType(checker, checker.getContextualType(node))) ||
        ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) &&
          namesAppType(checker, checker.getTypeFromTypeNode(node.type))) ||
        (ts.isCallExpression(node) &&
          node.expression.getText() === 'Object.assign' &&
          namesAppType(checker, checker.getContextualType(node)));
      if (!built) return void ts.forEachChild(node, walk);
      found.push({
        path,
        line: lineAt(node),
        message: 'builds an App: only src/compose.ts builds one, and tests take theirs from testApp in test/fixtures/',
      });
    };
    walk(file);
  }
  return found;
}
