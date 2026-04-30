// Direct unit tests for the pure helpers backing the "Test Node" scenario
// (`apps/web/docs/scenarios/workflow-editor/test-node.md`).
//
// These functions are the single source of truth for scenario invariants 3
// (NodeNotTestable のノードには事前に拒否する) and 4 (ダミー入力の型不一致は
// 実行前に検出する). Covering them directly here — rather than only through
// `testNodeWorkflow.test.ts` — makes regressions in the structural branching
// (reserved-key skip, `set` schema fallback, primitive vs object shape
// matching, the empty-`with:` shortcut) visible at the function boundary
// closest to the bug.

import { describe, expect, it } from 'vitest';
import { asNodeId } from '../entities/types';
import type { WorkflowDocument } from '../entities/workflowDocument';
import {
  locateNode,
  validateNodeInputs,
  type DummyInputs,
  type NodeDefinition,
} from './nodeTestability';

/**
 * Build a minimal `WorkflowDocument` from a plain `tasks` array. The scenario
 * never inspects `meta` so we leave it empty here — keeping the fixture
 * focused on the structural shape under test.
 */
function buildDocument(
  tasks: Array<Record<string, unknown>>,
): WorkflowDocument {
  return { meta: {}, tasks };
}

/**
 * Construct a `NodeDefinition` directly. `validateNodeInputs` is independent
 * of `locateNode`, so the two suites do not need to share a fixture.
 */
function buildNode(
  nodeType: string,
  body: Record<string, unknown>,
): NodeDefinition {
  return {
    nodeId: asNodeId('target'),
    nodeType,
    body: { [nodeType]: body[nodeType], ...body },
  };
}

describe('locateNode', () => {
  it('returns located for a `run` node with a well-formed body', () => {
    const doc = buildDocument([
      {
        greet: {
          run: { shell: { command: 'echo hello' } },
        },
      },
    ]);
    const r = locateNode(doc, asNodeId('greet'));
    expect(r.kind).toBe('located');
    if (r.kind !== 'located') return;
    expect(r.node.nodeId as string).toBe('greet');
    expect(r.node.nodeType).toBe('run');
  });

  it('returns located for a `set` node (also testable)', () => {
    const doc = buildDocument([
      {
        assign: {
          set: { name: 'world' },
        },
      },
    ]);
    const r = locateNode(doc, asNodeId('assign'));
    expect(r.kind).toBe('located');
    if (r.kind !== 'located') return;
    expect(r.node.nodeType).toBe('set');
  });

  it('returns notTestable for `if` nodes (invariant 3)', () => {
    const doc = buildDocument([
      {
        guarded: {
          if: { condition: 'true' },
        },
      },
    ]);
    const r = locateNode(doc, asNodeId('guarded'));
    expect(r).toEqual({ kind: 'notTestable', nodeType: 'if' });
  });

  it.each([
    ['switch'],
    ['loop'],
    ['for'],
    ['do'],
    ['fork'],
    ['try'],
    ['catch'],
    ['retry'],
  ])('returns notTestable for `%s` nodes', (nodeType) => {
    const doc = buildDocument([
      {
        target: { [nodeType]: {} },
      },
    ]);
    const r = locateNode(doc, asNodeId('target'));
    expect(r.kind).toBe('notTestable');
    if (r.kind !== 'notTestable') return;
    expect(r.nodeType).toBe(nodeType);
  });

  it('returns notFound when no task entry matches the node id', () => {
    const doc = buildDocument([
      { greet: { run: { shell: { command: 'echo' } } } },
    ]);
    const r = locateNode(doc, asNodeId('absent'));
    expect(r).toEqual({ kind: 'notFound' });
  });

  it('returns notFound when the task list is empty', () => {
    const doc = buildDocument([]);
    const r = locateNode(doc, asNodeId('any'));
    expect(r).toEqual({ kind: 'notFound' });
  });

  it('skips multi-key entries (malformed) when scanning for the id', () => {
    // A task entry must be a single-key map (the key being the task id).
    // An accidental two-key entry like `{ foo: ..., bar: ... }` is not a
    // valid task — locateNode should not match either key.
    const doc = buildDocument([
      { foo: {}, bar: {} },
      { greet: { run: { shell: { command: 'echo' } } } },
    ]);
    expect(locateNode(doc, asNodeId('foo'))).toEqual({ kind: 'notFound' });
    expect(locateNode(doc, asNodeId('bar'))).toEqual({ kind: 'notFound' });
    // The well-formed entry alongside the malformed one is still locatable.
    expect(locateNode(doc, asNodeId('greet')).kind).toBe('located');
  });

  it('returns notTestable with empty nodeType when the body is null', () => {
    const doc = buildDocument([{ broken: null as unknown as object }]);
    const r = locateNode(doc, asNodeId('broken'));
    expect(r).toEqual({ kind: 'notTestable', nodeType: '' });
  });

  it('returns notTestable with empty nodeType when the body is an array', () => {
    // Arrays are not valid task bodies (no node-type key to read).
    const doc = buildDocument([{ broken: [] as unknown as object }]);
    const r = locateNode(doc, asNodeId('broken'));
    expect(r).toEqual({ kind: 'notTestable', nodeType: '' });
  });

  it('skips reserved keys when picking the node type', () => {
    // `name`, `description`, `when`, `continue_on_error`, and `with` are
    // workflow-author metadata — they appear alongside the runtime-meaningful
    // node type but are not themselves node types. The first non-reserved
    // key in insertion order should be picked.
    const doc = buildDocument([
      {
        greet: {
          name: 'human-readable',
          description: 'says hello',
          when: 'always',
          continue_on_error: false,
          with: { name: 'string' },
          run: { shell: { command: 'echo' } },
        },
      },
    ]);
    const r = locateNode(doc, asNodeId('greet'));
    expect(r.kind).toBe('located');
    if (r.kind !== 'located') return;
    expect(r.node.nodeType).toBe('run');
  });

  it('returns notTestable when every key in the body is reserved metadata', () => {
    // A body with only metadata (no runtime-meaningful key) is structurally
    // unable to execute — surface as not-testable.
    const doc = buildDocument([
      {
        meta_only: {
          name: 'no body',
          description: 'has nothing to run',
        },
      },
    ]);
    const r = locateNode(doc, asNodeId('meta_only'));
    expect(r).toEqual({ kind: 'notTestable', nodeType: '' });
  });
});

describe('validateNodeInputs', () => {
  describe('with no `with:` declaration', () => {
    it('returns valid for a `run` node that does not declare a with: schema', () => {
      // No declared schema means there is nothing to validate against —
      // any inputs are accepted (scenario invariant 4 only applies when
      // there is an explicit declaration).
      const node = buildNode('run', {
        run: { shell: { command: 'echo hello' } },
      });
      expect(
        validateNodeInputs(node, { anything: 'goes' } as DummyInputs),
      ).toEqual({ kind: 'valid' });
    });

    it('returns valid for an empty `with:` declaration', () => {
      // An empty declaration object exists but has no required fields, so
      // every required-field check trivially passes. Empty inputs likewise
      // pass (no fields to type-check).
      const node = buildNode('run', {
        with: {},
        run: { shell: { command: 'echo' } },
      });
      expect(validateNodeInputs(node, {})).toEqual({ kind: 'valid' });
      expect(
        validateNodeInputs(node, { extra: 'value' } as DummyInputs),
      ).toEqual({ kind: 'valid' });
    });
  });

  describe('with declared inputs', () => {
    it('returns invalid with "missing required <field>" before type check', () => {
      // Required-fields check runs first so a missing field surfaces a more
      // actionable diagnostic than "type mismatch on undefined".
      const node = buildNode('run', {
        with: { working_directory: 'string', timeout_ms: 'number' },
        run: { shell: { command: 'echo' } },
      });
      const r = validateNodeInputs(node, { timeout_ms: 1000 } as DummyInputs);
      expect(r).toEqual({
        kind: 'invalid',
        reason: 'missing required working_directory',
      });
    });

    it('reports the FIRST missing field in declaration order', () => {
      // Determinism matters: if two fields are missing the diagnostic must
      // be reproducible across runs. We rely on Object.entries iteration
      // order, which mirrors insertion order for string keys in modern JS.
      const node = buildNode('run', {
        with: { alpha: 'string', beta: 'string', gamma: 'string' },
        run: { shell: { command: 'echo' } },
      });
      const r = validateNodeInputs(node, { gamma: 'g' } as DummyInputs);
      expect(r).toEqual({ kind: 'invalid', reason: 'missing required alpha' });
    });

    it('returns invalid with "type mismatch on <field>" for declared types', () => {
      // Marker strings ("string" / "number" / "boolean") are explicit type
      // declarations the validator must match against the JS typeof of the
      // actual value.
      const node = buildNode('run', {
        with: { count: 'number' },
        run: { shell: { command: 'echo' } },
      });
      const r = validateNodeInputs(node, { count: 'forty-two' } as DummyInputs);
      expect(r).toEqual({ kind: 'invalid', reason: 'type mismatch on count' });
    });

    it('returns valid when declared types match the inputs', () => {
      const node = buildNode('run', {
        with: { count: 'number', enabled: 'boolean', label: 'string' },
        run: { shell: { command: 'echo' } },
      });
      expect(
        validateNodeInputs(node, {
          count: 42,
          enabled: true,
          label: 'hello',
        } as DummyInputs),
      ).toEqual({ kind: 'valid' });
    });

    it('treats a primitive default as a same-type marker', () => {
      // A declaration like `name: "world"` is shorthand for "field is a
      // string, default to 'world'". The validator should require the
      // actual value to be a string.
      const node = buildNode('run', {
        with: { name: 'world', count: 7, flag: false },
        run: { shell: { command: 'echo' } },
      });
      // Wrong types fail fast.
      expect(
        validateNodeInputs(node, {
          name: 42,
          count: 7,
          flag: false,
        } as DummyInputs),
      ).toEqual({ kind: 'invalid', reason: 'type mismatch on name' });
      // Right types pass.
      expect(
        validateNodeInputs(node, {
          name: 'world',
          count: 7,
          flag: false,
        } as DummyInputs),
      ).toEqual({ kind: 'valid' });
    });

    it('accepts any actual value when expected is null or undefined', () => {
      // A declared `null` / `undefined` is a "no constraint" marker — the
      // field is acknowledged but the validator does not type-check it.
      const node = buildNode('run', {
        with: { freeform: null as unknown },
        run: { shell: { command: 'echo' } },
      });
      expect(
        validateNodeInputs(node, { freeform: 123 } as DummyInputs),
      ).toEqual({ kind: 'valid' });
      expect(
        validateNodeInputs(node, { freeform: 'text' } as DummyInputs),
      ).toEqual({ kind: 'valid' });
      expect(
        validateNodeInputs(node, { freeform: { nested: true } } as DummyInputs),
      ).toEqual({ kind: 'valid' });
    });

    it('matches arrays against array declarations', () => {
      const node = buildNode('run', {
        with: { tags: ['string'] },
        run: { shell: { command: 'echo' } },
      });
      expect(
        validateNodeInputs(node, { tags: ['a', 'b'] } as DummyInputs),
      ).toEqual({ kind: 'valid' });
      expect(
        validateNodeInputs(node, { tags: 'not-an-array' } as DummyInputs),
      ).toEqual({ kind: 'invalid', reason: 'type mismatch on tags' });
    });

    it('matches non-null objects against object declarations', () => {
      const node = buildNode('run', {
        with: { config: { host: 'string' } },
        run: { shell: { command: 'echo' } },
      });
      // An object is acceptable.
      expect(
        validateNodeInputs(node, {
          config: { host: 'localhost' },
        } as DummyInputs),
      ).toEqual({ kind: 'valid' });
      // An array is NOT an object for this purpose (matchesDeclaredType
      // rejects arrays when the declaration is an object).
      expect(
        validateNodeInputs(node, { config: [] as unknown } as DummyInputs),
      ).toEqual({ kind: 'invalid', reason: 'type mismatch on config' });
      // null is NOT an object either.
      expect(
        validateNodeInputs(node, { config: null as unknown } as DummyInputs),
      ).toEqual({ kind: 'invalid', reason: 'type mismatch on config' });
    });
  });

  describe('with `set` nodes', () => {
    it('uses the assignment map as the declared schema (no `with:` needed)', () => {
      // For `set` nodes the assignment map IS the input schema. Each key is
      // a field, each value's JS type is the expected type.
      const node: NodeDefinition = {
        nodeId: asNodeId('assign'),
        nodeType: 'set',
        body: {
          set: { name: 'world', count: 7 },
        },
      };
      // Right types pass.
      expect(
        validateNodeInputs(node, { name: 'hello', count: 1 } as DummyInputs),
      ).toEqual({ kind: 'valid' });
      // Wrong types fail.
      expect(
        validateNodeInputs(node, { name: 1, count: 1 } as DummyInputs),
      ).toEqual({ kind: 'invalid', reason: 'type mismatch on name' });
    });

    it('prefers an explicit `with:` declaration over the set-body fallback', () => {
      // If a `set` node also carries `with:`, the explicit declaration takes
      // precedence — readDeclaredInputs reads `with` before falling back to
      // the body shape.
      const node: NodeDefinition = {
        nodeId: asNodeId('assign'),
        nodeType: 'set',
        body: {
          with: { explicit: 'string' },
          set: { ignored: 42 },
        },
      };
      expect(
        validateNodeInputs(node, { explicit: 'value' } as DummyInputs),
      ).toEqual({ kind: 'valid' });
      // The set body's `ignored: 42` is NOT used as a schema here — only
      // `explicit` is required.
      expect(validateNodeInputs(node, {} as DummyInputs)).toEqual({
        kind: 'invalid',
        reason: 'missing required explicit',
      });
    });

    it('returns valid for a `set` node whose body is malformed (array)', () => {
      // If the set body is an array (not a record) there is no schema to
      // validate against, mirroring the "no declaration" branch.
      const node: NodeDefinition = {
        nodeId: asNodeId('assign'),
        nodeType: 'set',
        body: {
          set: [] as unknown as Record<string, unknown>,
        },
      };
      expect(validateNodeInputs(node, { x: 1 } as DummyInputs)).toEqual({
        kind: 'valid',
      });
    });
  });
});
