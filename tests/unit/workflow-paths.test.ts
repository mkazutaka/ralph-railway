import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listWorkflows, resolveWorkflow, workflowSearchDirs } from '../../src/workflow-paths';

let root: string;
let cwd: string;
let home: string;
let envDir: string;

function writeWf(dir: string, name: string, ext = '.yaml'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), '# test\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'way-paths-'));
  cwd = join(root, 'proj');
  home = join(root, 'home');
  envDir = join(root, 'shared');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('workflowSearchDirs: project → user → env order', () => {
  const dirs = workflowSearchDirs(cwd, { RALPH_RAILWAYS_PATH: envDir }, home);
  expect(dirs.map((d) => d.source)).toEqual(['project', 'user', 'env']);
  expect(dirs[0]?.dir).toBe(join(cwd, '.agents/railways'));
  expect(dirs[1]?.dir).toBe(join(home, '.agents/railways'));
  expect(dirs[2]?.dir).toBe(envDir);
});

test('workflowSearchDirs: no env var → no env entry', () => {
  const dirs = workflowSearchDirs(cwd, {}, home);
  expect(dirs.map((d) => d.source)).toEqual(['project', 'user']);
});

test('workflowSearchDirs: multiple colon-separated env paths', () => {
  const a = join(root, 'a');
  const b = join(root, 'b');
  const dirs = workflowSearchDirs(cwd, { RALPH_RAILWAYS_PATH: `${a}:${b}` }, home);
  expect(dirs.slice(2).map((d) => d.dir)).toEqual([a, b]);
});

test('resolveWorkflow: picks project over user', () => {
  writeWf(join(cwd, '.agents/railways'), 'shared');
  writeWf(join(home, '.agents/railways'), 'shared');
  const res = resolveWorkflow('shared', cwd, {}, home);
  expect(res?.source).toBe('project');
});

test('resolveWorkflow: falls back to user when absent from project', () => {
  writeWf(join(home, '.agents/railways'), 'userflow');
  const res = resolveWorkflow('userflow', cwd, {}, home);
  expect(res?.source).toBe('user');
  expect(res?.path).toBe(join(home, '.agents/railways', 'userflow.yaml'));
});

test('resolveWorkflow: falls back to env path last', () => {
  writeWf(envDir, 'envflow');
  const res = resolveWorkflow('envflow', cwd, { RALPH_RAILWAYS_PATH: envDir }, home);
  expect(res?.source).toBe('env');
});

test('resolveWorkflow: tries .yml when .yaml missing', () => {
  writeWf(join(cwd, '.agents/railways'), 'ymlflow', '.yml');
  const res = resolveWorkflow('ymlflow', cwd, {}, home);
  expect(res?.path).toBe(join(cwd, '.agents/railways', 'ymlflow.yml'));
});

test('resolveWorkflow: returns null when not found', () => {
  expect(resolveWorkflow('nope', cwd, {}, home)).toBeNull();
});

test('listWorkflows: merges sources, project wins on name collision', () => {
  writeWf(join(cwd, '.agents/railways'), 'a');
  writeWf(join(cwd, '.agents/railways'), 'shared');
  writeWf(join(home, '.agents/railways'), 'shared');
  writeWf(join(home, '.agents/railways'), 'b');
  writeWf(envDir, 'c');

  const items = listWorkflows(cwd, { RALPH_RAILWAYS_PATH: envDir }, home);
  const byName = Object.fromEntries(items.map((i) => [i.name, i.source]));
  expect(byName).toEqual({ a: 'project', shared: 'project', b: 'user', c: 'env' });
  // sorted
  expect(items.map((i) => i.name)).toEqual(['a', 'b', 'c', 'shared']);
});

test('listWorkflows: missing dirs are skipped silently', () => {
  writeWf(join(home, '.agents/railways'), 'only-user');
  const items = listWorkflows(cwd, {}, home);
  expect(items.map((i) => i.name)).toEqual(['only-user']);
});
