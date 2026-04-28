import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli.tsx');

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'way-err-'));
  mkdirSync(join(tmp, '.agents/railways'), { recursive: true });
  copyFileSync(
    resolve('tests/fixtures/error-bad-yaml.yaml'),
    join(tmp, '.agents/railways/bad-yaml.yaml'),
  );
  copyFileSync(
    resolve('tests/fixtures/error-bad-dsl.yaml'),
    join(tmp, '.agents/railways/bad-dsl.yaml'),
  );
  copyFileSync(
    resolve('tests/fixtures/error-missing-required.yaml'),
    join(tmp, '.agents/railways/missing-required.yaml'),
  );
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(name: string) {
  const proc = Bun.spawn(['bun', 'run', CLI, name, '--plain'], {
    cwd: tmp,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return {
    code,
    err: await new Response(proc.stderr).text(),
  };
}

test('malformed YAML exits non-zero with stderr message', async () => {
  const { code, err } = await run('bad-yaml');
  expect(code).toBe(2);
  expect(err.length).toBeGreaterThan(0);
});

test('DSL version mismatch exits non-zero', async () => {
  const { code, err } = await run('bad-dsl');
  expect(code).toBe(2);
  expect(err.length).toBeGreaterThan(0);
});

test('missing required fields exits non-zero', async () => {
  const { code, err } = await run('missing-required');
  expect(code).toBe(2);
  expect(err.length).toBeGreaterThan(0);
});
