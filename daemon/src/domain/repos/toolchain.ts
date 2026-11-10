// Works out how to set up, test and safely drive a repo from its root files.

export type Toolchain = 'pnpm' | 'yarn' | 'npm' | 'cargo' | 'uv' | 'go';

export interface ToolchainInfo {
  toolchain: Toolchain;
  setup_cmd: string;
  test_cmd: string | null; // null when a JS repo has no test script
  tools: string[]; // Bash rules for this toolchain only; the generic rules live in tools.ts
}

const MARKERS: [Toolchain, string[]][] = [
  ['pnpm', ['pnpm-lock.yaml']],
  ['yarn', ['yarn.lock']],
  ['npm', ['package-lock.json', 'package.json']],
  ['cargo', ['Cargo.toml']],
  ['uv', ['uv.lock', 'pyproject.toml']],
  ['go', ['go.mod']],
];

const SETUP: Record<Toolchain, string> = {
  pnpm: 'pnpm install --frozen-lockfile --prefer-offline',
  npm: 'npm ci --prefer-offline',
  yarn: 'yarn install --frozen-lockfile',
  cargo: 'cargo fetch',
  uv: 'uv sync',
  go: 'go mod download',
};

const JS: Toolchain[] = ['pnpm', 'yarn', 'npm'];

const PM_BUILTINS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'update',
  'up',
  'upgrade',
  'remove',
  'rm',
  'uninstall',
  'link',
  'publish',
  'dlx',
  'exec',
  'x',
]);

const SCRIPT_NAME = /^[\w:.@/-]+$/;

export function toolchainTools(toolchain: Toolchain, packageScripts: string[] = []): string[] {
  switch (toolchain) {
    case 'pnpm':
    case 'yarn':
    case 'npm': {
      const scripts = packageScripts.filter((s) => SCRIPT_NAME.test(s) && !PM_BUILTINS.has(s));
      const rules = [...scripts.map((s) => `Bash(${toolchain} ${s}*)`), `Bash(${toolchain} test*)`, `Bash(${toolchain} run *)`];
      return [...new Set(rules)];
    }
    case 'cargo':
      return ['Bash(cargo build*)', 'Bash(cargo test*)', 'Bash(cargo check*)', 'Bash(cargo fmt*)', 'Bash(cargo clippy*)'];
    case 'uv':
      return ['Bash(uv run *)'];
    case 'go':
      return ['Bash(go test*)', 'Bash(go build*)', 'Bash(go vet*)', 'Bash(gofmt*)'];
  }
}

export function testCommand(toolchain: Toolchain, packageScripts: string[] = []): string | null {
  if (JS.includes(toolchain)) return packageScripts.includes('test') ? `${toolchain} test` : null;
  if (toolchain === 'cargo') return 'cargo test';
  if (toolchain === 'uv') return 'uv run pytest';
  return 'go test ./...';
}

export function detectToolchain(files: string[], packageScripts: string[]): ToolchainInfo | null {
  const present = new Set(files);
  const toolchain = MARKERS.find(([, markers]) => markers.some((f) => present.has(f)))?.[0];
  if (!toolchain) return null;
  return {
    toolchain,
    setup_cmd: SETUP[toolchain],
    test_cmd: testCommand(toolchain, packageScripts),
    tools: toolchainTools(toolchain, packageScripts),
  };
}

export function isToolchain(s: string | null | undefined): s is Toolchain {
  return MARKERS.some(([t]) => t === s);
}
