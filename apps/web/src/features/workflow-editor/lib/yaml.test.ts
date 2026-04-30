import { describe, expect, it } from 'vitest';
import { asYamlSource, asPatternId } from '../entities/types';
import { listTaskIds } from '../entities/workflowDocument';
import { mergePatternIntoDocument, parseWorkflowYaml, serializeYaml } from './yaml';
import type { PatternTemplate } from '../entities/pattern';

const setPattern: PatternTemplate = {
  id: asPatternId('set'),
  label: 'set',
  description: '',
  supported: true,
  tasks: [{ assign_step: { set: { foo: 'bar' } } }],
};

describe('parseWorkflowYaml', () => {
  it('parses a valid workflow into meta + tasks', () => {
    const result = parseWorkflowYaml(
      asYamlSource('document:\n  name: demo\ndo:\n  - step1:\n      run:\n        shell:\n          command: ls\n'),
    );
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') return;
    expect(result.document.meta).toEqual({ document: { name: 'demo' } });
    expect(listTaskIds(result.document)).toEqual(['step1']);
  });

  it('treats a missing top-level `do` as an empty task list (regression: #3)', () => {
    // YAML semantics: a key without a value parses to `null`, but the scenario
    // says only *syntactically* broken YAML should be rejected. A workflow
    // with no `do:` key at all is logically empty and must be insertable into
    // — otherwise the very first pattern could never be added to a fresh file.
    const result = parseWorkflowYaml(asYamlSource('document:\n  name: demo\n'));
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') return;
    expect(result.document.tasks).toEqual([]);
  });

  it('treats `do: null` (empty value) as an empty task list (regression: #3)', () => {
    // `do:` with no value lexes as `do: null`. Same reasoning as the missing
    // key case above — refuse only on real syntax errors, not on a deliberately
    // empty workflow.
    const result = parseWorkflowYaml(asYamlSource('do:\n'));
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') return;
    expect(result.document.tasks).toEqual([]);
  });

  it('returns parseError when `do` is a scalar (not a list)', () => {
    const result = parseWorkflowYaml(asYamlSource('do: hello\n'));
    expect(result.kind).toBe('parseError');
  });

  it('returns parseError on broken YAML', () => {
    const result = parseWorkflowYaml(asYamlSource('do: [unclosed\n'));
    expect(result.kind).toBe('parseError');
  });

  it('rejects __proto__ as a top-level key (security: prototype pollution defence M-4)', () => {
    // A YAML mapping with `__proto__:` would be valid JSON_SCHEMA. We refuse
    // it at parse time so it never reaches `serializeYaml` and can't be
    // round-tripped onto disk for downstream consumers to merge into their
    // own object graphs.
    const result = parseWorkflowYaml(asYamlSource('__proto__:\n  polluted: true\n'));
    expect(result.kind).toBe('parseError');
  });

  it('rejects __proto__ nested deep inside a task value (security: M-4)', () => {
    // The forbidden-key check must walk the full value tree, not just the
    // root. A task whose body smuggles `__proto__: {...}` deep inside a
    // `run:` block has the same end-state risk.
    const result = parseWorkflowYaml(
      asYamlSource('do:\n  - step:\n      run:\n        __proto__:\n          polluted: true\n'),
    );
    expect(result.kind).toBe('parseError');
  });

  it('rejects constructor / prototype as keys (security: M-4)', () => {
    expect(parseWorkflowYaml(asYamlSource('constructor:\n  evil: true\n')).kind).toBe('parseError');
    expect(parseWorkflowYaml(asYamlSource('prototype:\n  evil: true\n')).kind).toBe('parseError');
  });

  it('rejects unsupported YAML tags (security: schema must be JSON-only)', () => {
    // js-yaml's default schema can resolve some non-trivial tags. With
    // JSON_SCHEMA pinned, anything outside JSON-representable values throws
    // and we propagate it as a parse error rather than instantiating it.
    const malicious = asYamlSource('do:\n  - !!js/function "function () { return 1 }"\n');
    const result = parseWorkflowYaml(malicious);
    expect(result.kind).toBe('parseError');
  });
});

describe('mergePatternIntoDocument', () => {
  it('appends pattern tasks while preserving existing IDs (invariant 2)', () => {
    const parsed = parseWorkflowYaml(
      asYamlSource('do:\n  - existing:\n      set:\n        x: 1\n'),
    );
    if (parsed.kind !== 'parsed') throw new Error('expected parsed');

    const merged = mergePatternIntoDocument(parsed.document, setPattern);
    expect(merged.kind).toBe('merged');
    if (merged.kind !== 'merged') return;
    expect(listTaskIds(merged.document)).toEqual(['existing', 'assign_step']);
  });

  it('renames colliding template IDs without touching existing tasks', () => {
    const parsed = parseWorkflowYaml(
      asYamlSource('do:\n  - assign_step:\n      set:\n        keep: true\n'),
    );
    if (parsed.kind !== 'parsed') throw new Error('expected parsed');

    const merged = mergePatternIntoDocument(parsed.document, setPattern);
    if (merged.kind !== 'merged') throw new Error('expected merged');
    const ids = listTaskIds(merged.document);
    expect(ids[0]).toBe('assign_step');
    expect(ids[1]).toBe('assign_step_2');
    // First entry's value must still be the original.
    const first = merged.document.tasks[0]!;
    expect(first.assign_step).toEqual({ set: { keep: true } });
  });

  it('returns templateMalformed when a template entry has != 1 keys', () => {
    const parsed = parseWorkflowYaml(asYamlSource('do: []\n'));
    if (parsed.kind !== 'parsed') throw new Error('expected parsed');

    const malformed: PatternTemplate = {
      ...setPattern,
      tasks: [{ a: 1, b: 2 } as Record<string, unknown>],
    };
    const merged = mergePatternIntoDocument(parsed.document, malformed);
    expect(merged.kind).toBe('templateMalformed');
  });
});

describe('serializeYaml roundtrip', () => {
  it('produces YAML that re-parses to an equivalent document', () => {
    const parsed = parseWorkflowYaml(
      asYamlSource(
        'document:\n  name: demo\ndo:\n  - a:\n      set:\n        n: 1\n  - b:\n      set:\n        n: 2\n',
      ),
    );
    if (parsed.kind !== 'parsed') throw new Error('expected parsed');

    const out = serializeYaml(parsed.document);
    const reparsed = parseWorkflowYaml(out);
    expect(reparsed.kind).toBe('parsed');
    if (reparsed.kind !== 'parsed') return;
    expect(listTaskIds(reparsed.document)).toEqual(['a', 'b']);
    expect(reparsed.document.meta).toEqual({ document: { name: 'demo' } });
  });

  it('post-merge YAML round-trips through parseWorkflowYaml (invariant 1)', () => {
    // Exercise the safety net used by `insertPatternWorkflow` step 5: after
    // merging a pattern, the serialized YAML must remain parseable.
    const parsed = parseWorkflowYaml(
      asYamlSource('do:\n  - existing:\n      set:\n        x: 1\n'),
    );
    if (parsed.kind !== 'parsed') throw new Error('expected parsed');

    const merged = mergePatternIntoDocument(parsed.document, setPattern);
    if (merged.kind !== 'merged') throw new Error('expected merged');

    const reparsed = parseWorkflowYaml(serializeYaml(merged.document));
    expect(reparsed.kind).toBe('parsed');
    if (reparsed.kind !== 'parsed') return;
    expect(listTaskIds(reparsed.document)).toEqual(['existing', 'assign_step']);
  });

  it('appending into a parsed empty `do:` produces re-parseable YAML', () => {
    // Combines the `do: null` normalization with the merge step — covers the
    // "first pattern into a freshly created workflow" path end-to-end.
    const parsed = parseWorkflowYaml(asYamlSource('do:\n'));
    if (parsed.kind !== 'parsed') throw new Error('expected parsed');

    const merged = mergePatternIntoDocument(parsed.document, setPattern);
    if (merged.kind !== 'merged') throw new Error('expected merged');

    const reparsed = parseWorkflowYaml(serializeYaml(merged.document));
    expect(reparsed.kind).toBe('parsed');
    if (reparsed.kind !== 'parsed') return;
    expect(listTaskIds(reparsed.document)).toEqual(['assign_step']);
  });
});
