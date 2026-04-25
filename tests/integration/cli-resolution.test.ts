import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli.tsx');

const MIN_YAML = `document:
  dsl: "1.0.3"
  namespace: example
  name: __SOURCE__
  version: "0.1.0"
do:
  - tag:
      set: { from: "__SOURCE__" }
`;

let projectCwd: string;
let fakeHome: string;
let envDir: string;

beforeAll(() => {
  projectCwd = mkdtempSync(join(tmpdir(), 'way-proj-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'way-home-'));
  envDir = mkdtempSync(join(tmpdir(), 'way-env-'));
  mkdirSync(join(projectCwd, '.agents/railways'), { recursive: true });
  mkdirSync(join(fakeHome, '.agents/railways'), { recursive: true });

  writeFileSync(
    join(projectCwd, '.agents/railways/dup.yaml'),
    MIN_YAML.replace(/__SOURCE__/g, 'project'),
  );
  writeFileSync(
    join(fakeHome, '.agents/railways/dup.yaml'),
    MIN_YAML.replace(/__SOURCE__/g, 'user'),
  );
  writeFileSync(
    join(fakeHome, '.agents/railways/user-only.yaml'),
    MIN_YAML.replace(/__SOURCE__/g, 'user'),
  );
  writeFileSync(join(envDir, 'env-only.yaml'), MIN_YAML.replace(/__SOURCE__/g, 'env'));
});

afterAll(() => {
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(envDir, { recursive: true, force: true });
});

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    cwd: projectCwd,
    env: { ...process.env, HOME: fakeHome, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return {
    code,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}

test('--list shows project, user, and env sources', async () => {
  const { code, out } = await run(['--list'], { RALPH_RAILWAYS_PATH: envDir });
  expect(code).toBe(0);
  expect(out).toContain('dup');
  expect(out).toContain('(project)');
  expect(out).toContain('user-only');
  expect(out).toContain('(user)');
  expect(out).toContain('env-only');
  expect(out).toContain('(env)');
});

test('project beats user when names collide', async () => {
  const { code, out } = await run(['dup', '--plain', '--verbose']);
  expect(code).toBe(0);
  expect(out).toContain('"from": "project"');
});

test('user-only workflow is found via $HOME', async () => {
  const { code, out } = await run(['user-only', '--plain', '--verbose']);
  expect(code).toBe(0);
  expect(out).toContain('"from": "user"');
});

test('env-only workflow is found via $RALPH_RAILWAYS_PATH', async () => {
  const { code, out } = await run(['env-only', '--plain', '--verbose'], {
    RALPH_RAILWAYS_PATH: envDir,
  });
  expect(code).toBe(0);
  expect(out).toContain('"from": "env"');
});
