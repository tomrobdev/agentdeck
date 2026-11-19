import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBranchCiWarning } from '#domain/repos/index.ts';

const KOC = `name: ci
on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop, main]
jobs:
  test:
    runs-on: ubuntu-latest
`;

const AGENTDECK = `name: check

on:
  pull_request:
  workflow_dispatch: # starts it on each branch of a stack
  push:
    branches: [main]
`;

const WITH_PLAN = `name: ci
on:
  pull_request:
    branches:
      - develop
      - main
      - 'plan/**'
`;

test('a workflow whose pull_request branches are develop and main warns, with the line to add', () => {
  const warning = planBranchCiWarning([{ path: '.github/workflows/ci.yml', text: KOC }]);
  assert.match(warning ?? '', /\.github\/workflows\/ci\.yml runs on pull_request only into develop, main/);
  assert.match(warning ?? '', /add 'plan\/\*\*' to its pull_request branches/);
});

test('a workflow with no branches filter on pull_request passes', () => {
  assert.equal(planBranchCiWarning([{ path: '.github/workflows/check.yml', text: AGENTDECK }]), null);
});

test('a workflow whose branches list has plan/** passes', () => {
  assert.equal(planBranchCiWarning([{ path: '.github/workflows/ci.yml', text: WITH_PLAN }]), null);
});

test('one workflow that runs on every pull request is enough, and a repo with no pull_request trigger has nothing to warn about', () => {
  assert.equal(
    planBranchCiWarning([
      { path: 'a.yml', text: KOC },
      { path: 'b.yml', text: AGENTDECK },
    ]),
    null,
  );
  assert.equal(planBranchCiWarning([{ path: 'c.yml', text: 'on:\n  push:\n    branches: [main]\n' }]), null);
  assert.equal(planBranchCiWarning([]), null);
});

test('the short forms of on are read: a string, a list, a flow list of branches and branches-ignore', () => {
  assert.equal(planBranchCiWarning([{ path: 'a.yml', text: 'on: pull_request\n' }]), null);
  assert.equal(planBranchCiWarning([{ path: 'a.yml', text: 'on: [push, pull_request]\n' }]), null);
  assert.equal(planBranchCiWarning([{ path: 'a.yml', text: 'on:\n  - push\n  - pull_request\n' }]), null);
  assert.match(planBranchCiWarning([{ path: 'a.yml', text: 'on:\n  pull_request:\n    branches: main\n' }]) ?? '', /only into main/);
  assert.match(
    planBranchCiWarning([{ path: 'a.yml', text: "on:\n  pull_request:\n    branches-ignore: ['plan/**']\n" }]) ?? '',
    /take plan\/\*\* out of its branches-ignore/,
  );
  assert.equal(planBranchCiWarning([{ path: 'a.yml', text: "on:\n  pull_request:\n    branches-ignore: ['docs/**']\n" }]), null);
});

test('block lists, comments, quoted keys, a missing on and a trigger with only types are read', () => {
  const text = (body: string) => [{ path: 'a.yml', text: body }];
  assert.match(
    planBranchCiWarning(text('"on":\n  pull_request: # every PR\n    branches-ignore:\n      - "plan/**"\n      - docs\n')) ?? '',
    /except into plan\/\*\*, docs/,
  );
  assert.equal(planBranchCiWarning(text('"on":\n  pull_request:\n    types: [opened]\n')), null);
  assert.equal(planBranchCiWarning(text('name: nothing\njobs: {}\n')), null);
  assert.equal(
    planBranchCiWarning(text('on:\n  pull_request:\n    branches:\n      - develop\n  schedule:\n    - cron: "0 0 * * *"\n')) === null,
    false,
  );
  assert.equal(planBranchCiWarning(text('on:\n  pull_request:\n    branches:\n')), null, 'an empty list is no filter');
  assert.match(
    planBranchCiWarning(text('on:\n  pull_request:\n    branches:\n      - main\n      stray: line\n')) ?? '',
    /only into main$|only into main,/,
  );
  assert.equal(planBranchCiWarning(text('on:\n  pull_request:\n    branches: [develop]\n    branches-ignore: [docs]\n')) === null, false);
});

test('branch patterns follow GitHub: * stays inside a folder, ** crosses folders', () => {
  const only = (pattern: string) => planBranchCiWarning([{ path: 'a.yml', text: `on:\n  pull_request:\n    branches: ['${pattern}']\n` }]);
  assert.equal(only('plan/*'), null);
  assert.equal(only('**'), null);
  assert.equal(only('plan/**'), null);
  assert.notEqual(only('release/*'), null);
  assert.notEqual(only('*'), null);
});
