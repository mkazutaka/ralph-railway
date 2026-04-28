import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test('runs minimal workflow end to end', async () => {
  const wf = loadWorkflow('tests/fixtures/cli-minimal.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  expect(outputs.greet).toEqual({ message: 'hello world' });
  expect(outputs.finish).toEqual({ done: true });
});
