import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURE = resolve('tests/fixtures/cli-minimal.yaml');
const CLI = resolve('src/cli.tsx');

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'way-'));
  mkdirSync(join(tmp, '.agents/railways'), { recursive: true });
  copyFileSync(FIXTURE, join(tmp, '.agents/railways/minimal.yaml'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function run(
  args: string[],
  opts: { cwd?: string; home?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    cwd: opts.cwd ?? tmp,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: opts.home ?? tmp },
  });
  const code = await proc.exited;
  return {
    code,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}

test('--version prints version', async () => {
  const { code, out } = await run(['--version']);
  expect(code).toBe(0);
  expect(out).toContain('0.0.1');
});

test('--help prints usage with new flags', async () => {
  const { code, out } = await run(['--help']);
  expect(code).toBe(0);
  expect(out).toContain('Usage:');
  expect(out).toContain('way <name>');
  expect(out).toContain('--list');
  expect(out).toContain('--plain');
  expect(out).toContain('--verbose');
  expect(out).toContain('validate <name|path>');
});

test('--list prints available workflow names with source', async () => {
  const { code, out } = await run(['--list']);
  expect(code).toBe(0);
  expect(out).toContain('minimal');
  expect(out).toContain('(project)');
});

test('--list in a dir with no .agents/railways exits 0 with empty output', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'way-empty-'));
  try {
    const { code, out } = await run(['--list'], { cwd: empty, home: empty });
    expect(code).toBe(0);
    expect(out).toBe('');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('way <name> --plain runs the workflow', async () => {
  const { code } = await run(['minimal', '--plain']);
  expect(code).toBe(0);
});

test('way <name> --plain --verbose prints outputs JSON on stdout and progress on stderr', async () => {
  const { code, out, err } = await run(['minimal', '--plain', '--verbose']);
  expect(code).toBe(0);
  expect(out).toContain('greet');
  expect(out).toContain('finish');
  expect(out).toContain('hello world');
  // Plain mode emits one JSON event per line on stderr.
  expect(err).toContain('task:start');
  expect(err).toContain('task:end');
});

test('unknown workflow exits 2', async () => {
  const { code, err } = await run(['no-such-workflow', '--plain']);
  expect(code).toBe(2);
  expect(err).toContain('not found');
});

test('missing workflow name exits 2 with usage hint', async () => {
  const { code, err } = await run(['--verbose']);
  expect(code).toBe(2);
  expect(err).toContain('requires a workflow name');
});

test('unreferenced trailing positionals fail strict validation (exit 2)', async () => {
  const { code, err } = await run(['minimal', 'stray-arg', '--plain']);
  expect(code).toBe(2);
  expect(err).toContain('does not reference');
});

test('-- sentinel forwards dash-prefixed args to the workflow', async () => {
  const { code, err } = await run(['minimal', '--plain', '--', '--not-a-flag']);
  // Same strict error — proves --not-a-flag was accepted as an arg, not as a way flag.
  expect(code).toBe(2);
  expect(err).toContain('does not reference');
});

test('expands <ARGUMENTS> and <N> end-to-end in --plain --verbose', async () => {
  const ARGS_FIXTURE = resolve('tests/fixtures/cli-args.yaml');
  copyFileSync(ARGS_FIXTURE, join(tmp, '.agents/railways/args-demo.yaml'));

  const { code, out } = await run(['args-demo', 'alpha', 'beta', '--plain', '--verbose']);
  expect(code).toBe(0);
  expect(out).toContain('hello alpha beta');
  expect(out).toContain('"first": "alpha"');
});

test('validate <name> succeeds for a valid workflow resolved from search dirs', async () => {
  const { code, out } = await run(['validate', 'minimal']);
  expect(code).toBe(0);
  expect(out).toContain('ok:');
  expect(out).toContain('minimal.yaml');
});

test('validate <path> succeeds for a valid file path', async () => {
  const path = resolve('tests/fixtures/cli-minimal.yaml');
  const { code, out } = await run(['validate', path]);
  expect(code).toBe(0);
  expect(out).toContain('ok:');
  expect(out).toContain(path);
});

test('validate <path> exits 2 with a diagnostic for a malformed workflow', async () => {
  const path = resolve('tests/fixtures/error-bad-dsl.yaml');
  const { code, err } = await run(['validate', path]);
  expect(code).toBe(2);
  expect(err).toContain('invalid:');
});

test('validate without a target exits 2 with a usage hint', async () => {
  const { code, err } = await run(['validate']);
  expect(code).toBe(2);
  expect(err).toContain('validate requires');
});

test('validate with an unknown name exits 2', async () => {
  const { code, err } = await run(['validate', 'no-such-workflow']);
  expect(code).toBe(2);
  expect(err).toContain('not found');
});
