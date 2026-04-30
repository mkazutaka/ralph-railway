import { describe, expect, it } from 'vitest';
import { asWorkflowId, asYamlSource } from '../entities/types';
import type { WorkflowFile } from '../entities/workflowFile';
import { extractWorkflowSummary } from '../lib/extractWorkflowSummary';
import { listWorkflowsWorkflow } from './listWorkflowsWorkflow';

function file(id: string, yaml: string): WorkflowFile {
  return { id: asWorkflowId(id), yaml: asYamlSource(yaml) };
}

describe('listWorkflowsWorkflow', () => {
  it('returns an empty WorkflowList when the directory has no workflows (invariant 1)', async () => {
    const out = await listWorkflowsWorkflow({
      listWorkflowFiles: async () => [],
      extractWorkflowSummary,
    });
    expect(out.kind).toBe('workflowList');
    expect(out.workflows).toEqual([]);
  });

  it('summarises each file by extracting document.name with filename fallback (invariant 2)', async () => {
    const out = await listWorkflowsWorkflow({
      listWorkflowFiles: async () => [
        file('a.yaml', 'document:\n  name: Alpha Pipeline\ndo: []\n'),
        file('b.yaml', 'do: []\n'), // no document.name → fallback to "b"
        file('broken.yml', 'do: [unclosed\n'), // parse error → fallback to "broken"
      ],
      extractWorkflowSummary,
    });
    expect(out.workflows.map((w) => ({ id: w.id as string, name: w.name }))).toEqual([
      { id: 'a.yaml', name: 'Alpha Pipeline' },
      { id: 'b.yaml', name: 'b' },
      { id: 'broken.yml', name: 'broken' },
    ]);
  });

  it('forwards the file order from the repository verbatim', async () => {
    // The repository (and the underlying store) is responsible for ordering;
    // the workflow itself must not re-sort, so a non-alphabetical input
    // survives the round-trip unchanged.
    const out = await listWorkflowsWorkflow({
      listWorkflowFiles: async () => [
        file('z.yaml', 'do: []\n'),
        file('a.yaml', 'do: []\n'),
      ],
      extractWorkflowSummary,
    });
    expect(out.workflows.map((w) => w.id as string)).toEqual(['z.yaml', 'a.yaml']);
  });

  it('preserves WorkflowId uniqueness across the listing (invariant 3)', async () => {
    // The filesystem makes id collisions impossible, but we still assert the
    // contract here so a future store implementation that yields duplicates
    // is caught by the unit test rather than reaching the UI.
    const out = await listWorkflowsWorkflow({
      listWorkflowFiles: async () => [
        file('one.yaml', 'document:\n  name: One\ndo: []\n'),
        file('two.yaml', 'document:\n  name: Two\ndo: []\n'),
      ],
      extractWorkflowSummary,
    });
    const ids = out.workflows.map((w) => w.id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
