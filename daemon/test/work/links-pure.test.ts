// Pure tests of task links: where a link stands, when a task may start, and who it releases or leaves stuck.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '../../src/domain/shared/index.ts';
import type { Dependency } from '../../src/domain/work/links/link.ts';
import {
  type Link,
  type LinkIndex,
  type LinkTarget,
  buildsOnError,
  buildsOnRepoError,
  canInstallWith,
  dependentViews,
  depsRequest,
  depsRequestError,
  installArgs,
  isNeeds,
  linkError,
  linkViews,
  parseNeeds,
  prModeOffError,
  releasedBy,
  startState,
  stuckOn,
  unblocksOf,
  unlandedAfter,
} from '../../src/domain/work/index.ts';

const id = asTaskId;
const merged: Dependency = { status: 'done', done_by: null, pr: { state: 'merged' }, pr_mode: 'ready' };
const open: Dependency = { status: 'done', done_by: null, pr: { state: 'open' }, pr_mode: 'ready' };
const running: Dependency = { status: 'running', pr: null, pr_mode: 'ready' };
const failed: Dependency = { status: 'failed', pr: null, pr_mode: 'ready' };
const cancelled: Dependency = { status: 'cancelled', pr: null, pr_mode: 'ready' };
const builds = (task: number, on: number): Link => ({ task_id: id(task), on: id(on), kind: 'builds_on' });
const after = (task: number, on: number): Link => ({ task_id: id(task), on: id(on), kind: 'after' });

const index = (targets: Record<number, Dependency>, links: Link[]): LinkIndex => ({
  linksOf: (t) => links.filter((l) => l.task_id === t),
  dependentsOf: (t) => links.filter((l) => l.on === t).map((l) => ({ id: l.task_id, status: 'queued', kind: l.kind })),
  target: (t): LinkTarget | undefined => (targets[t] ? { ...targets[t], links: links.filter((l) => l.task_id === t) } : undefined),
});

test('startState: a task building on nothing starts; on merged work it is met; on work under way it waits', () => {
  const lookup = (t: Record<number, Dependency>, links: Link[]) => index(t, links).target;
  assert.deepEqual(startState({ id: id(1) }, [], lookup({}, [])), { kind: 'none' });
  assert.deepEqual(startState({ id: id(1) }, [after(1, 2)], lookup({ 2: running }, [])), { kind: 'none' });
  assert.deepEqual(startState({ id: id(1) }, [builds(1, 2)], lookup({ 2: merged }, [])), { kind: 'met' });
  assert.deepEqual(startState({ id: id(1) }, [builds(1, 2), builds(1, 3)], lookup({ 2: running, 3: open }, [])), {
    kind: 'waiting',
    on: [2, 3],
  });
});

test('startState: a failed, cancelled or missing task it builds on leaves it stuck, down a chain too', () => {
  const stuck = (t: Record<number, Dependency>, links: Link[]) => startState({ id: id(1) }, links, index(t, links).target);
  assert.deepEqual(stuck({ 2: failed }, [builds(1, 2)]), { kind: 'stuck', on: 2, reason: '#2 failed' });
  assert.deepEqual(stuck({ 2: cancelled }, [builds(1, 2)]), { kind: 'stuck', on: 2, reason: '#2 was cancelled' });
  assert.deepEqual(stuck({}, [builds(1, 2)]), { kind: 'stuck', on: 2, reason: '#2 no longer exists' });
  const closed: Dependency = { status: 'done', done_by: null, pr: { state: 'closed' }, pr_mode: 'ready' };
  assert.equal(stuck({ 2: closed }, [builds(1, 2)]).kind, 'stuck');
  const chain = stuck({ 2: running, 3: failed }, [builds(1, 2), builds(2, 3)]);
  assert.deepEqual(chain, { kind: 'stuck', on: 3, reason: 'waits on #3 (via #2), which failed' });
});

test('a done task by a person is met unless its PR is open; with PRs off a done task is met without one', () => {
  const links = [builds(1, 2)];
  const state = (d: Dependency) => startState({ id: id(1) }, links, index({ 2: d }, links).target).kind;
  assert.equal(state({ status: 'done', done_by: 'person', pr: null, pr_mode: 'ready' }), 'met');
  assert.equal(state({ status: 'done', done_by: 'person', pr: { state: 'open' }, pr_mode: 'ready' }), 'waiting');
  assert.equal(state({ status: 'done', done_by: null, pr: null, pr_mode: 'off' }), 'met');
  assert.equal(state({ status: 'done', done_by: null, pr: null, pr_mode: 'ready' }), 'waiting');
  assert.equal(state({ status: 'done', done_by: null, pr: { state: 'failed' }, pr_mode: 'ready' }), 'stuck');
});

test('unlandedAfter lists the after links whose task has not landed, and skips one that never will', () => {
  const links = [after(1, 2), after(1, 3), after(1, 4), builds(1, 5)];
  const lookup = (t: number) => ({ 2: open, 3: cancelled, 4: merged, 5: running })[t];
  assert.deepEqual(unlandedAfter(links, lookup), [{ on: 2, reason: "#2's PR is not merged yet" }]);
  assert.deepEqual(
    unlandedAfter([after(1, 9)], () => undefined),
    [],
  );
  assert.deepEqual(
    unlandedAfter([after(1, 6)], () => failed),
    [{ on: 6, reason: '#6 failed' }],
  );
});

test('stuckOn finds the queued tasks stuck on a task, and releasedBy those that start once it merges', () => {
  const links = [builds(2, 1), builds(3, 2)];
  const stuckIndex = index({ 1: failed, 2: { status: 'queued', pr: null, pr_mode: 'ready' } }, links);
  assert.deepEqual(
    stuckOn(id(1), stuckIndex).map((t) => t.id),
    [2, 3],
  );
  const waiting = index({ 1: open, 2: running }, [builds(2, 1)]);
  assert.deepEqual(
    releasedBy(id(1), waiting).map((t) => t.id),
    [2],
  );
  assert.deepEqual(releasedBy(id(1), index({ 1: open, 2: running }, [builds(2, 1), builds(2, 7)])), []);
});

test('a task in review unblocks the tasks that start when it merges; any other stage unblocks none', () => {
  const links = index({ 1: open, 2: running }, [builds(2, 1)]);
  assert.deepEqual(unblocksOf({ id: id(1), status: 'done', pr: { state: 'open' } as never }, links), [2]);
  assert.deepEqual(unblocksOf({ id: id(1), status: 'running', pr: null }, links), []);
});

test('linkViews and dependentViews show each link with where it stands, and the tasks that depend on one', () => {
  const links = index({ 2: merged, 3: failed }, [builds(1, 2), after(1, 3), builds(4, 1)]);
  assert.deepEqual(linkViews(id(1), links), [
    { on: 2, kind: 'builds_on', state: 'met' },
    { on: 3, kind: 'after', state: 'unlanded' },
  ]);
  assert.deepEqual(dependentViews(id(1), links), [{ id: 4, kind: 'builds_on' }]);
});

test('linkError refuses a task linked to itself, a repeated link and a cycle', () => {
  assert.equal(linkError(id(1), id(1), []), "#1 can't depend on itself");
  assert.equal(linkError(id(1), id(2), [builds(1, 2)]), '#1 is already linked to #2');
  assert.equal(linkError(id(1), id(3), [builds(3, 2), after(2, 1)]), 'linking #1 to #3 would make a cycle');
  assert.equal(linkError(id(1), id(2), [builds(2, 3), builds(3, 4)]), null);
});

test('a task that has started cannot build on another, and a repo that opens no PRs cannot be built on', () => {
  assert.equal(buildsOnError(id(1), 'queued', id(2)), null);
  assert.equal(buildsOnError(id(1), 'proposed', id(2)), null);
  assert.match(buildsOnError(id(1), 'running', id(2)) ?? '', /#1 has started already/);
  assert.equal(buildsOnRepoError(id(2), { name: 'r', pr_mode: 'ready' }), null);
  assert.match(buildsOnRepoError(id(2), { name: 'r', pr_mode: 'off' }) ?? '', /#2 is in r, which opens no PRs/);
});

test('a repo cannot stop opening PRs while a task builds on one that is not merged, and the message agrees in number', () => {
  assert.equal(prModeOffError('r', []), null);
  assert.match(prModeOffError('r', [id(3)]) ?? '', /#3 builds on .* wait for it to start, or cancel it/);
  assert.match(prModeOffError('r', [id(3), id(4)]) ?? '', /#3, #4 build on .* wait for them to start, or cancel them/);
});

test('parseNeeds reads NEEDS deps, host or edit with its items, and nothing else', () => {
  assert.deepEqual(parseNeeds('NEEDS deps: left-pad, lodash'), { kind: 'deps', items: ['left-pad', 'lodash'] });
  assert.deepEqual(parseNeeds('needs HOST : a.com'), { kind: 'host', items: ['a.com'] });
  assert.equal(parseNeeds('NEEDS edit:'), undefined);
  assert.equal(parseNeeds('NEEDS tea: x'), undefined);
  assert.equal(parseNeeds(undefined), undefined);
});

test('isNeeds accepts a kind and items and rejects the rest', () => {
  assert.ok(isNeeds({ kind: 'deps', items: [] }));
  assert.ok(!isNeeds({ kind: 'tea', items: [] }));
  assert.ok(!isNeeds({ kind: 'deps' }));
  assert.ok(!isNeeds(null));
});

test('only the JS package managers can install packages', () => {
  assert.ok(canInstallWith('pnpm') && canInstallWith('npm') && canInstallWith('yarn'));
  assert.ok(!canInstallWith('cargo') && !canInstallWith(null) && !canInstallWith(undefined));
});

test('a deps request separates the dev flag from the packages and must name valid ones', () => {
  assert.deepEqual(depsRequest(['left-pad', '-D']), { packages: ['left-pad'], dev: true });
  assert.deepEqual(depsRequest(['--dev', 'a']), { packages: ['a'], dev: true });
  assert.deepEqual(depsRequest(['a']), { packages: ['a'], dev: false });
  assert.equal(depsRequestError(['@scope/pkg@1.2.3', 'left-pad']), null);
  assert.equal(depsRequestError(['-D']), 'the request names no packages');
  assert.equal(depsRequestError(['Bad Pkg', 'x;rm']), 'not a valid package name: Bad Pkg x;rm');
});

test('installArgs uses install --save for npm and add for pnpm and yarn, with the dev flag each uses', () => {
  assert.deepEqual(installArgs('npm', ['a'], false), ['install', '--save', 'a']);
  assert.deepEqual(installArgs('npm', ['a'], true), ['install', '--save-dev', 'a']);
  assert.deepEqual(installArgs('pnpm', ['a', 'b'], false), ['add', 'a', 'b']);
  assert.deepEqual(installArgs('yarn', ['a'], true), ['add', '-D', 'a']);
});
