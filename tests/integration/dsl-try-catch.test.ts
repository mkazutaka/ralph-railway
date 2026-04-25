import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test('try/catch surfaces error type and message under .var.<as>', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-try-catch.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  const recovered = outputs.recovered as { kind: string; msg: string };
  expect(recovered).toBeDefined();
  expect(recovered.kind).toBe('Error');
  expect(recovered.msg).toContain('switch');
});
