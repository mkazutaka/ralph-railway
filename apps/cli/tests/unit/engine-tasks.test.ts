import { expect, test } from 'bun:test';
import { normalizeTaskEntry, normalizeTaskList } from '../../src/engine/tasks';

test('infers set kind', () => {
  const t = normalizeTaskEntry({ hello: { set: { msg: 'hi' } } });
  expect(t).toEqual({ name: 'hello', kind: 'set', body: { set: { msg: 'hi' } } });
});

test('infers call kind', () => {
  const t = normalizeTaskEntry({ fetch: { call: 'http', with: { endpoint: 'https://x' } } });
  expect(t.kind).toBe('call');
});

test('infers all control-flow kinds', () => {
  expect(normalizeTaskEntry({ a: { for: { each: 'x', in: '[]' }, do: [] } }).kind).toBe('for');
  expect(normalizeTaskEntry({ a: { switch: [] } }).kind).toBe('switch');
  expect(normalizeTaskEntry({ a: { fork: { branches: [] } } }).kind).toBe('fork');
  expect(normalizeTaskEntry({ a: { try: [], catch: {} } }).kind).toBe('try');
  expect(normalizeTaskEntry({ a: { do: [] } }).kind).toBe('do');
});

test('rejects entry with zero or multiple keys', () => {
  expect(() => normalizeTaskEntry({ a: { set: {} }, b: { set: {} } })).toThrow();
  expect(() => normalizeTaskEntry({})).toThrow();
});

test('rejects unknown kind', () => {
  expect(() => normalizeTaskEntry({ x: { bogus: {} } })).toThrow(/unknown task kind/);
});

test('normalizeTaskList maps entries', () => {
  const list = normalizeTaskList([{ a: { set: {} } }, { b: { set: {} } }]);
  expect(list.map((t) => t.name)).toEqual(['a', 'b']);
});
