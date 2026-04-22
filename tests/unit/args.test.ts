import { describe, expect, test } from 'bun:test';
import { expandArgs } from '../../src/args';
import { WorkflowValidationError } from '../../src/engine/errors';

describe('expandArgs', () => {
  test('replaces <ARGUMENTS> with space-joined args', () => {
    const wf = { do: [{ t: { set: { m: 'hello <ARGUMENTS>!' } } }] } as any;
    expandArgs(wf, ['foo', 'bar']);
    expect(wf.do[0].t.set.m).toBe('hello foo bar!');
  });

  test('replaces <N> with Nth positional (1-indexed)', () => {
    const wf = { do: [{ t: { set: { m: '<2> then <1>' } } }] } as any;
    expandArgs(wf, ['a', 'b']);
    expect(wf.do[0].t.set.m).toBe('b then a');
  });

  test('walks nested arrays and records', () => {
    const wf = {
      do: [{ loop: { for: { in: 'pick <1>' }, do: [{ s: { set: { x: '<1>-x' } } }] } }],
    } as any;
    expandArgs(wf, ['ok']);
    expect(wf.do[0].loop.for.in).toBe('pick ok');
    expect(wf.do[0].loop.do[0].s.set.x).toBe('ok-x');
  });

  test('does not touch map keys', () => {
    const wf = { do: [{ '<1>': { set: { x: '<1>' } } }] } as any;
    expandArgs(wf, ['ok']);
    expect(Object.keys(wf.do[0])[0]).toBe('<1>');
    expect(wf.do[0]['<1>'].set.x).toBe('ok');
  });

  test('throws WorkflowValidationError when <N> exceeds arg count', () => {
    const wf = { do: [{ t: { set: { m: 'need <3>' } } }] } as any;
    expect(() => expandArgs(wf, ['only-one'])).toThrow(WorkflowValidationError);
  });

  test('throws when <ARGUMENTS> is used with zero args', () => {
    const wf = { do: [{ t: { set: { m: 'hi <ARGUMENTS>' } } }] } as any;
    expect(() => expandArgs(wf, [])).toThrow(WorkflowValidationError);
  });

  test('throws when args supplied but no placeholder appears anywhere', () => {
    const wf = { do: [{ t: { set: { m: 'plain' } } }] } as any;
    expect(() => expandArgs(wf, ['stray'])).toThrow(WorkflowValidationError);
  });

  test('no args + no placeholders is a no-op', () => {
    const wf = { do: [{ t: { set: { m: 'plain' } } }] } as any;
    expect(() => expandArgs(wf, [])).not.toThrow();
    expect(wf.do[0].t.set.m).toBe('plain');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal jq expression in test description
  test('leaves ${ ... } jq expressions alone', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal jq expression under test
    const JQ_EXPR = '${ .input.x }';
    const wf = { do: [{ t: { set: { m: JQ_EXPR } } }] } as any;
    expandArgs(wf, []);
    expect(wf.do[0].t.set.m).toBe(JQ_EXPR);
  });

  test('throws WorkflowValidationError on <0>', () => {
    const wf = { do: [{ t: { set: { m: 'bad <0>' } } }] } as any;
    expect(() => expandArgs(wf, ['x'])).toThrow(WorkflowValidationError);
  });

  test('supports multi-digit <N>', () => {
    const args = Array.from({ length: 12 }, (_, i) => `a${i + 1}`);
    const wf = { do: [{ t: { set: { m: 'pick <12>' } } }] } as any;
    expandArgs(wf, args);
    expect(wf.do[0].t.set.m).toBe('pick a12');
  });

  test('validation runs before mutation (tree unchanged on throw)', () => {
    const wf = { do: [{ ok: { set: { m: '<1>' } } }, { bad: { set: { m: 'need <9>' } } }] } as any;
    expect(() => expandArgs(wf, ['only-one'])).toThrow(WorkflowValidationError);
    expect(wf.do[0].ok.set.m).toBe('<1>'); // still original, not 'only-one'
  });
});
