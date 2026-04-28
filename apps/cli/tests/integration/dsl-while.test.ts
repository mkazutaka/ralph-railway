import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test('for+while stops when continuation condition becomes falsy', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-while.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  // While `value < 3` runs the body; on the 4th evaluation value === 3 so loop exits.
  expect(outputs.counter).toEqual({ value: 3 });
});
