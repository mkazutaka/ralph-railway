import { describe, expect, it } from 'vitest';
import { asWorkflowId, asYamlSource } from '../entities/types';
import { createWorkflowWorkflow } from './createWorkflowWorkflow';
import type { CreateWorkflowFile } from '../repositories/workflowFileRepository';
import { parseWorkflowYaml } from '../lib/yaml';

const validYaml = asYamlSource('document:\n  name: demo\ndo: []\n');

function makeDeps(overrides: { create?: CreateWorkflowFile } = {}) {
  const writes: Array<{ id: string; yaml: string }> = [];
  const create: CreateWorkflowFile =
    overrides.create ??
    (async (id, yaml) => {
      writes.push({ id, yaml });
      return { kind: 'created' };
    });
  return {
    deps: {
      createWorkflowFile: create,
      parseWorkflowYaml,
    },
    writes,
  };
}

describe('createWorkflowWorkflow', () => {
  it('persists the YAML and returns workflowCreated on the happy path', async () => {
    const { deps, writes } = makeDeps();
    const out = await createWorkflowWorkflow(
      { workflowId: asWorkflowId('hello.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('workflowCreated');
    if (out.kind !== 'workflowCreated') return;
    expect(out.created.id as string).toBe('hello.yaml');
    expect(out.created.name).toBe('hello');
    expect(writes).toEqual([{ id: 'hello.yaml', yaml: validYaml }]);
  });

  it('returns invalidYaml without persisting when the YAML cannot be parsed', async () => {
    const { deps, writes } = makeDeps();
    const out = await createWorkflowWorkflow(
      {
        workflowId: asWorkflowId('broken.yaml'),
        yaml: asYamlSource('do: [unclosed\n'),
      },
      deps,
    );
    expect(out.kind).toBe('invalidYaml');
    expect(writes).toEqual([]);
  });

  it('returns duplicateId when the repository observes an existing file', async () => {
    const { deps } = makeDeps({
      create: async () => ({ kind: 'alreadyExists' }),
    });
    const out = await createWorkflowWorkflow(
      { workflowId: asWorkflowId('exists.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('duplicateId');
  });

  it('returns persistFailed when the repository rejects the id structurally', async () => {
    const { deps } = makeDeps({
      create: async () => ({ kind: 'invalidId', reason: 'invalid extension' }),
    });
    const out = await createWorkflowWorkflow(
      { workflowId: asWorkflowId('weird.yaml'), yaml: validYaml },
      deps,
    );
    expect(out.kind).toBe('persistFailed');
    if (out.kind !== 'persistFailed') return;
    expect(out.reason).toBe('invalid extension');
  });
});
