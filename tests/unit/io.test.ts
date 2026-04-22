import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowValidationError } from '../../src/engine/errors';
import { loadWorkflow } from '../../src/io';

const tmpDir = join(tmpdir(), `way-io-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

function write(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

describe('loadWorkflow', () => {
  test('parses minimal fixture into a hydrated Workflow', () => {
    const wf = loadWorkflow('tests/fixtures/minimal-workflow.yaml');
    expect(wf.document.dsl).toBe('1.0.3');
    expect(wf.document.name).toBe('minimal');
    expect(Array.isArray(wf.do)).toBe(true);
    expect(wf.do).toHaveLength(2);
  });

  test('accepts call:claude (project extension allowed by SDK)', () => {
    const path = write(
      'with-claude.yaml',
      `
document: { dsl: "1.0.3", namespace: t, name: w, version: "0.1.0" }
do:
  - ask:
      call: claude
      with:
        prompt: "hi"
`,
    );
    expect(() => loadWorkflow(path)).not.toThrow();
  });

  test('accepts for.while (SLW v1.0.3 while-loop primitive)', () => {
    const path = write(
      'for-while.yaml',
      `
document: { dsl: "1.0.3", namespace: t, name: w, version: "0.1.0" }
do:
  - loop:
      for: { each: i, in: "\${ [range(1; 10)] }" }
      while: "\${ true }"
      do:
        - step: { set: { x: 1 } }
`,
    );
    expect(() => loadWorkflow(path)).not.toThrow();
  });

  test('rejects top-level while: (not in SLW v1.0.3 spec)', () => {
    const path = write(
      'bad-while.yaml',
      `
document: { dsl: "1.0.3", namespace: t, name: w, version: "0.1.0" }
do:
  - loop:
      while: "\${ true }"
      do:
        - step: { set: { x: 1 } }
`,
    );
    expect(() => loadWorkflow(path)).toThrow();
  });

  test('rejects a missing file', () => {
    expect(() => loadWorkflow('tests/fixtures/does-not-exist.yaml')).toThrow();
  });

  test('rejects wrong dsl version', () => {
    const path = write(
      'bad-dsl.yaml',
      'document: { dsl: "1.0.0", namespace: t, name: w, version: "0.1.0" }\ndo: []\n',
    );
    expect(() => loadWorkflow(path)).toThrow();
  });

  test('expands <ARGUMENTS> when args are supplied', () => {
    const path = write(
      'with-args.yaml',
      `
document: { dsl: "1.0.3", namespace: t, name: w, version: "0.1.0" }
do:
  - greet:
      call: claude
      with:
        prompt: "Explain <ARGUMENTS>"
`,
    );
    const wf = loadWorkflow(path, ['src/engine']);
    expect((wf.do as any)[0].greet.with.prompt).toBe('Explain src/engine');
  });

  test('throws when <N> exceeds supplied args', () => {
    const path = write(
      'bad-args.yaml',
      `
document: { dsl: "1.0.3", namespace: t, name: w, version: "0.1.0" }
do:
  - greet:
      call: claude
      with:
        prompt: "<1> and <2>"
`,
    );
    expect(() => loadWorkflow(path, ['only'])).toThrow(WorkflowValidationError);
  });
});
