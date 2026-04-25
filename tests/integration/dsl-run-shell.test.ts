import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineBus } from '../../src/engine/events';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test('non-zero exit returns {stdout,stderr,code} without throwing', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-run-nonzero.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  const failing = outputs.failing as { stdout: string; stderr: string; code: number };
  expect(failing.code).toBe(7);
  expect(failing.stdout).toContain('on-stdout');
  expect(failing.stderr).toContain('on-stderr');
});

test('shell stdout streams via shell:stdout events', async () => {
  const bus = new EngineBus();
  const chunks: string[] = [];
  bus.on((e) => {
    if (e.kind === 'shell:stdout') chunks.push((e as { chunk: string }).chunk);
  });
  const wf = loadWorkflow('tests/fixtures/dsl-run-streaming.yaml');
  await new Engine(bus).runWorkflow(wf);
  const joined = chunks.join('');
  expect(joined).toContain('line-1');
  expect(joined).toContain('line-2');
  expect(joined).toContain('line-3');
});

test('large stdout is fully captured (1 MB)', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-run-large.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  const big = outputs.big as { stdout: string; code: number };
  expect(big.code).toBe(0);
  expect(big.stdout.length).toBe(1024 * 1024);
});

test('run.shell honors workDir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'way-wd-'));
  try {
    writeFileSync(join(dir, 'marker.txt'), 'hello\n');
    const wfText = `document:
  dsl: "1.0.3"
  namespace: example
  name: dsl-run-wd
  version: "0.1.0"
do:
  - peek:
      run:
        shell:
          command: "cat marker.txt"
`;
    const fixturePath = join(dir, 'wf.yaml');
    writeFileSync(fixturePath, wfText);
    const wf = loadWorkflow(fixturePath);
    const outputs = await new Engine().runWorkflow(wf, { workDir: dir });
    const peek = outputs.peek as { stdout: string; code: number };
    expect(peek.code).toBe(0);
    expect(peek.stdout).toBe('hello\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
