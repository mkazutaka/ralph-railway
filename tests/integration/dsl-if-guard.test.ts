import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test('if=false skips task; if=true runs it', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-if-guard.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  expect(outputs.skipped).toBeUndefined();
  expect(outputs.kept).toEqual({ reached: true });
});

test('if inside for.do behaves like continue', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-if-guard.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  // for-loop's iterScope shares outputs with parent — "last write wins".
  // even_only ran for n=2 and n=4. Final value is 4.
  const even = outputs.even_only as { latest_even: number };
  expect(even).toBeDefined();
  expect(even.latest_even).toBe(4);
});
