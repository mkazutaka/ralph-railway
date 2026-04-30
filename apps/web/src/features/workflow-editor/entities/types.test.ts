// Regression tests for the branded constructors in `entities/types.ts`.
//
// The `WorkflowId` regex doubles as a security boundary: any name accepted
// here ends up reaching `assertValidId` in `$lib/server/workflows`, which
// only enforces "no path separators" + "valid extension". Holes in the
// regex therefore translate directly into permissive disk filenames.

import { describe, expect, it } from 'vitest';
import {
  asPatternId,
  asWorkflowId,
  asYamlSource,
  InvalidBrandedValueError,
} from './types';

describe('asWorkflowId', () => {
  it.each([
    'demo.yaml',
    'demo.yml',
    'release.v2.yaml',
    'daily-cron.yml',
    'a.b.c.yaml',
    'a_b.yml',
    'A1.yaml',
  ])('accepts %j', (id) => {
    expect(asWorkflowId(id) as string).toBe(id);
  });

  it.each([
    '',
    '/etc/passwd',
    'a/b.yaml',
    'a\\b.yaml',
    'a\0b.yaml',
    '.yaml',
    '..yaml',
    '-leading.yaml',
    'trailing-.yaml',
    'no-extension',
    'wrong.json',
    'a..b.yaml', // M-2 regression: consecutive dots used to slip through.
    'a..b..c.yaml',
  ])('rejects %j', (id) => {
    expect(() => asWorkflowId(id)).toThrow(InvalidBrandedValueError);
  });

  it('rejects ids whose UTF-8 byte length exceeds 255 (review note M2)', () => {
    // 251 ASCII chars + ".yaml" (5 chars) = 256 bytes, one over NAME_MAX.
    const tooLong = `${'a'.repeat(251)}.yaml`;
    expect(Buffer.byteLength(tooLong, 'utf8')).toBe(256);
    expect(() => asWorkflowId(tooLong)).toThrow(InvalidBrandedValueError);
    try {
      asWorkflowId(tooLong);
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidBrandedValueError);
      if (e instanceof InvalidBrandedValueError) {
        expect(e.brand).toBe('WorkflowId');
        expect(e.reason).toBe('too long');
      }
    }
    // Boundary: exactly 255 bytes should still be accepted.
    const exact = `${'a'.repeat(250)}.yaml`;
    expect(Buffer.byteLength(exact, 'utf8')).toBe(255);
    expect(asWorkflowId(exact) as string).toBe(exact);
  });
});

describe('asPatternId', () => {
  it.each(['do', 'if', 'switch', 'fork', 'loop', 'try', 'retry', 'set', 'try-catch'])(
    'accepts the showcase id %j',
    (id) => {
      expect(asPatternId(id) as string).toBe(id);
    },
  );

  it.each(['', 'Set', 'do!', '1do', 'a'.repeat(64), 'with space'])('rejects %j', (id) => {
    expect(() => asPatternId(id)).toThrow(InvalidBrandedValueError);
  });
});

describe('asYamlSource', () => {
  it('accepts arbitrary text including unicode', () => {
    const yaml = 'document:\n  name: 日本語\n';
    expect(asYamlSource(yaml) as string).toBe(yaml);
  });

  it('rejects strings containing NUL bytes', () => {
    expect(() => asYamlSource('document:\n  name: \0\n')).toThrow(InvalidBrandedValueError);
  });
});
