import { expect, test } from 'bun:test';
import { Scope } from '../../src/engine/scope';

test('bind and get on a single scope', () => {
  const s = new Scope();
  s.bind('x', 1);
  expect(s.get('x')).toBe(1);
  expect(s.has('x')).toBe(true);
  expect(s.has('missing')).toBe(false);
});

test('missing key throws', () => {
  const s = new Scope();
  expect(() => s.get('missing')).toThrow(/scope key not found/);
});

test('child reads fall through to parent', () => {
  const p = new Scope();
  p.bind('x', 1);
  const c = p.child();
  expect(c.get('x')).toBe(1);
  expect(c.has('x')).toBe(true);
});

test('child writes do not leak to parent', () => {
  const p = new Scope();
  const c = p.child();
  c.bind('x', 2);
  expect(c.get('x')).toBe(2);
  expect(p.has('x')).toBe(false);
});

test('child binding shadows parent binding locally', () => {
  const p = new Scope();
  p.bind('x', 1);
  const c = p.child();
  c.bind('x', 99);
  expect(c.get('x')).toBe(99);
  expect(p.get('x')).toBe(1);
});

test('toObject merges with innermost-wins', () => {
  const p = new Scope();
  p.bind('x', 1);
  p.bind('y', 'outer');
  const c = p.child();
  c.bind('y', 'inner');
  c.bind('z', true);
  expect(c.toObject()).toEqual({ x: 1, y: 'inner', z: true });
  expect(p.toObject()).toEqual({ x: 1, y: 'outer' });
});
