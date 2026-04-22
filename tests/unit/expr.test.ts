/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is the jq expression syntax under test */
import { expect, test } from 'bun:test';
import { evaluate } from '../../src/jq';

test('pure expression returns native value', async () => {
  expect(await evaluate('${ .input.x }', { input: { x: 42 } })).toBe(42);
  expect(await evaluate('${ .input.items }', { input: { items: [1, 2, 3] } })).toEqual([1, 2, 3]);
});

test('plain string returned unchanged', async () => {
  expect(await evaluate('plain text', {})).toBe('plain text');
});

test('interpolation concatenates stringified values', async () => {
  const ctx = { input: { name: 'world' }, var: { n: 3 } };
  expect(await evaluate('hello ${ .input.name }!', ctx)).toBe('hello world!');
  expect(await evaluate('${ .var.n } items', ctx)).toBe('3 items');
});
