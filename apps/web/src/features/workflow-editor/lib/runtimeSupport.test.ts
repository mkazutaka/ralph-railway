import { describe, expect, it } from 'vitest';
import { asYamlSource } from '../entities/types';
import { parseWorkflowYaml } from './yaml';
import { validateRuntimeSupport } from './runtimeSupport';

function parse(yaml: string) {
  const result = parseWorkflowYaml(asYamlSource(yaml));
  if (result.kind !== 'parsed') {
    throw new Error(`fixture YAML failed to parse: ${result.reason}`);
  }
  return result.document;
}

describe('validateRuntimeSupport', () => {
  it('returns supported for a document with only supported nodes', async () => {
    const doc = parse(
      'do:\n  - greet:\n      run:\n        shell:\n          command: "echo hi"\n',
    );
    const r = validateRuntimeSupport(doc);
    expect(r.kind).toBe('supported');
  });

  it('returns supported for an empty document (no tasks)', () => {
    const doc = parse('document:\n  name: empty\n');
    const r = validateRuntimeSupport(doc);
    // No tasks → nothing to reject. The runtime can accept (and trivially
    // complete) an empty workflow.
    expect(r.kind).toBe('supported');
  });

  it('returns unsupportedNode for a top-level fork', () => {
    const doc = parse(
      'do:\n  - parallel_step:\n      fork:\n        branches:\n          - do:\n              - inner:\n                  run:\n                    shell:\n                      command: "true"\n',
    );
    const r = validateRuntimeSupport(doc);
    expect(r.kind).toBe('unsupportedNode');
    if (r.kind !== 'unsupportedNode') return;
    expect(r.nodeType).toBe('fork');
  });

  it('returns unsupportedNode for a try/catch', () => {
    const doc = parse(
      'do:\n  - guarded:\n      try:\n        do:\n          - risky:\n              run:\n                shell:\n                  command: "false"\n      catch:\n        do: []\n',
    );
    const r = validateRuntimeSupport(doc);
    expect(r.kind).toBe('unsupportedNode');
    if (r.kind !== 'unsupportedNode') return;
    expect(r.nodeType).toBe('try');
  });

  it('returns unsupportedNode for retry', () => {
    const doc = parse(
      'do:\n  - flaky:\n      retry:\n        max: 3\n',
    );
    const r = validateRuntimeSupport(doc);
    expect(r.kind).toBe('unsupportedNode');
    if (r.kind !== 'unsupportedNode') return;
    expect(r.nodeType).toBe('retry');
  });

  it('detects unsupported nodes nested inside a do block', () => {
    // Outer `if` is supported; the `fork` buried inside the inner `do`
    // must still be flagged. The naive "look at the outer key only"
    // implementation would let this pass and the runtime would crash —
    // hence this regression-shaped test.
    const doc = parse(
      'do:\n  - guarded:\n      if: "${ true }"\n      do:\n        - inner:\n            fork:\n              branches: []\n',
    );
    const r = validateRuntimeSupport(doc);
    expect(r.kind).toBe('unsupportedNode');
    if (r.kind !== 'unsupportedNode') return;
    expect(r.nodeType).toBe('fork');
  });

  it('treats supported keys (run, do, if, switch, loop, set, for) as runtime-supported', () => {
    const doc = parse(
      [
        'do:',
        '  - r:',
        '      run:',
        '        shell:',
        '          command: "echo r"',
        '  - g:',
        '      if: "${ true }"',
        '      run:',
        '        shell:',
        '          command: "echo g"',
        '  - s:',
        '      set:',
        '        x: 1',
        '  - sw:',
        '      switch:',
        '        on: "${ .var.k }"',
        '        cases: []',
        '  - l:',
        '      for:',
        '        each: "i"',
        '        in: "${ .var.items }"',
        '      do: []',
        '',
      ].join('\n'),
    );
    const r = validateRuntimeSupport(doc);
    expect(r.kind).toBe('supported');
  });
});
