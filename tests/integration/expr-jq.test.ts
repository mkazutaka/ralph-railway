import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test('jq supports split / select / range / // / contains', async () => {
  const wf = loadWorkflow('tests/fixtures/expr-jq-complex.yaml');
  const outputs = await new Engine().runWorkflow(wf);
  const parse = outputs.parse as {
    files: string[];
    ts_only: string[];
    first_three: number[];
    defaulted: string;
    contains_md: boolean;
  };
  expect(parse.files).toEqual(['a.ts', 'b.md', 'c.ts']);
  expect(parse.ts_only).toEqual(['a.ts', 'c.ts']);
  expect(parse.first_three).toEqual([1, 2, 3]);
  expect(parse.defaulted).toBe('fallback');
  expect(parse.contains_md).toBe(true);
});
