import { describe, expect, it } from 'vitest';
import { asWorkflowId, asYamlSource } from '../entities/types';
import { saveWorkflowWorkflow } from './saveWorkflowWorkflow';
import type {
  WorkflowFileExists,
  WriteWorkflowFile,
} from '../repositories/workflowFileRepository';

const validYaml = asYamlSource('document:\n  name: demo\ndo: []\n');
const FIXED_NOW = 1_700_000_000_000;

function makeDeps(overrides: {
  exists?: WorkflowFileExists;
  write?: WriteWorkflowFile;
  now?: () => number;
} = {}) {
  const writes: Array<{ id: string; yaml: string }> = [];
  const exists: WorkflowFileExists = overrides.exists ?? (async () => true);
  const write: WriteWorkflowFile =
    overrides.write ??
    (async (id, yaml) => {
      writes.push({ id, yaml });
      return { kind: 'written' };
    });
  const now = overrides.now ?? (() => FIXED_NOW);
  return {
    deps: {
      workflowFileExists: exists,
      writeWorkflowFile: write,
      now,
    },
    writes,
  };
}

describe('saveWorkflowWorkflow', () => {
  it('persists the YAML and returns workflowSaved on the happy path', async () => {
    const { deps, writes } = makeDeps();
    const out = await saveWorkflowWorkflow(
      { workflowId: asWorkflowId('hello.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('workflowSaved');
    if (out.kind !== 'workflowSaved') return;
    expect(out.saved.id as string).toBe('hello.yaml');
    expect(out.saved.savedAt).toBe(FIXED_NOW);
    expect(writes).toEqual([{ id: 'hello.yaml', yaml: validYaml }]);
  });

  it('persists syntactically broken YAML verbatim (scenario invariant 2)', async () => {
    // The save-workflow scenario explicitly tolerates unparseable YAML so the
    // user can preserve mid-edit buffers. The workflow must therefore not
    // call any parser and must hand the raw source straight to the writer.
    const { deps, writes } = makeDeps();
    const broken = asYamlSource('do: [unclosed\n');
    const out = await saveWorkflowWorkflow(
      { workflowId: asWorkflowId('mid-edit.yaml'), yaml: broken },
      deps,
    );
    expect(out.kind).toBe('workflowSaved');
    expect(writes).toEqual([{ id: 'mid-edit.yaml', yaml: broken }]);
  });

  it('returns notFound without writing when the file does not exist', async () => {
    const { deps, writes } = makeDeps({ exists: async () => false });
    const out = await saveWorkflowWorkflow(
      { workflowId: asWorkflowId('missing.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('notFound');
    expect(writes).toEqual([]);
  });

  it('returns invalidId when the store rejects the id structurally', async () => {
    const { deps } = makeDeps({
      write: async () => ({ kind: 'invalidId', reason: 'bad extension' }),
    });
    const out = await saveWorkflowWorkflow(
      { workflowId: asWorkflowId('weird.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('invalidId');
    if (out.kind !== 'invalidId') return;
    expect(out.reason).toBe('bad extension');
  });

  it('returns storageFailure when the underlying write reports an I/O error', async () => {
    const { deps } = makeDeps({
      write: async () => ({ kind: 'storageFailure', reason: 'EACCES' }),
    });
    const out = await saveWorkflowWorkflow(
      { workflowId: asWorkflowId('locked.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('storageFailure');
    if (out.kind !== 'storageFailure') return;
    expect(out.reason).toBe('EACCES');
  });

  it('does not call writeWorkflowFile when existence probe says notFound', async () => {
    let writeCalls = 0;
    const out = await saveWorkflowWorkflow(
      { workflowId: asWorkflowId('missing.yaml'), yaml: validYaml },
      {
        workflowFileExists: async () => false,
        writeWorkflowFile: async () => {
          writeCalls += 1;
          return { kind: 'written' };
        },
        now: () => FIXED_NOW,
      },
    );
    expect(out.kind).toBe('notFound');
    expect(writeCalls).toBe(0);
  });
});
