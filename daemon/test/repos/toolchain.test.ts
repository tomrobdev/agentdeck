import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectToolchain } from '#domain/repos/toolchain.ts';

const JS_SCRIPTS = ['build', 'test', 'typecheck'];

const cases: { name: string; files: string[]; scripts?: string[]; want: ReturnType<typeof detectToolchain> }[] = [
  {
    name: 'pnpm lockfile',
    files: ['package.json', 'pnpm-lock.yaml', 'src'],
    scripts: JS_SCRIPTS,
    want: {
      toolchain: 'pnpm',
      setup_cmd: 'pnpm install --frozen-lockfile --prefer-offline',
      test_cmd: 'pnpm test',
      tools: ['Bash(pnpm build*)', 'Bash(pnpm test*)', 'Bash(pnpm typecheck*)', 'Bash(pnpm run *)'],
    },
  },
  {
    name: 'yarn lockfile',
    files: ['package.json', 'yarn.lock'],
    scripts: ['lint'],
    want: {
      toolchain: 'yarn',
      setup_cmd: 'yarn install --frozen-lockfile',
      test_cmd: null,
      tools: ['Bash(yarn lint*)', 'Bash(yarn test*)', 'Bash(yarn run *)'],
    },
  },
  {
    name: 'npm lockfile',
    files: ['package.json', 'package-lock.json'],
    scripts: ['test'],
    want: { toolchain: 'npm', setup_cmd: 'npm ci --prefer-offline', test_cmd: 'npm test', tools: ['Bash(npm test*)', 'Bash(npm run *)'] },
  },
  {
    name: 'bare package.json is npm; install-like and odd script names get no rule',
    files: ['package.json'],
    scripts: ['install', 'add', 'dev', 'x; rm -rf /'],
    want: {
      toolchain: 'npm',
      setup_cmd: 'npm ci --prefer-offline',
      test_cmd: null,
      tools: ['Bash(npm dev*)', 'Bash(npm test*)', 'Bash(npm run *)'],
    },
  },
  {
    name: 'cargo',
    files: ['Cargo.toml', 'Cargo.lock', 'src'],
    want: {
      toolchain: 'cargo',
      setup_cmd: 'cargo fetch',
      test_cmd: 'cargo test',
      tools: ['Bash(cargo build*)', 'Bash(cargo test*)', 'Bash(cargo check*)', 'Bash(cargo fmt*)', 'Bash(cargo clippy*)'],
    },
  },
  {
    name: 'uv lockfile',
    files: ['uv.lock', 'pyproject.toml'],
    want: { toolchain: 'uv', setup_cmd: 'uv sync', test_cmd: 'uv run pytest', tools: ['Bash(uv run *)'] },
  },
  {
    name: 'pyproject only',
    files: ['pyproject.toml'],
    want: { toolchain: 'uv', setup_cmd: 'uv sync', test_cmd: 'uv run pytest', tools: ['Bash(uv run *)'] },
  },
  {
    name: 'go',
    files: ['go.mod', 'go.sum', 'main.go'],
    want: {
      toolchain: 'go',
      setup_cmd: 'go mod download',
      test_cmd: 'go test ./...',
      tools: ['Bash(go test*)', 'Bash(go build*)', 'Bash(go vet*)', 'Bash(gofmt*)'],
    },
  },
  {
    name: 'a lockfile beats other markers (JS front end in a Rust repo)',
    files: ['Cargo.toml', 'package.json', 'pnpm-lock.yaml'],
    scripts: [],
    want: {
      toolchain: 'pnpm',
      setup_cmd: 'pnpm install --frozen-lockfile --prefer-offline',
      test_cmd: null,
      tools: ['Bash(pnpm test*)', 'Bash(pnpm run *)'],
    },
  },
  { name: 'unknown repo', files: ['README.md', 'Makefile', 'main.c'], want: null },
  { name: 'empty repo', files: [], want: null },
];

for (const c of cases) {
  test(`detectToolchain: ${c.name}`, () => {
    assert.deepEqual(detectToolchain(c.files, c.scripts ?? []), c.want);
  });
}

test('toolchain rules never allow installs', () => {
  for (const files of [['pnpm-lock.yaml'], ['yarn.lock'], ['package.json'], ['Cargo.toml'], ['uv.lock'], ['go.mod']]) {
    const info = detectToolchain(files, ['install', 'add', 'ci', 'test'])!;
    for (const rule of info.tools) assert.doesNotMatch(rule, /\b(install|add|ci|sync|fetch|download|get)\b/, rule);
  }
});
