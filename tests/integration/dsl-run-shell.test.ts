import { expect, test } from 'bun:test';
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
