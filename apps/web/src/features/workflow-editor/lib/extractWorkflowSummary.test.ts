import { describe, expect, it } from 'vitest';
import { asWorkflowId, asYamlSource } from '../entities/types';
import type { WorkflowFile } from '../entities/workflowFile';
import { extractWorkflowSummary } from './extractWorkflowSummary';

function file(id: string, yaml: string): WorkflowFile {
  return { id: asWorkflowId(id), yaml: asYamlSource(yaml) };
}

describe('extractWorkflowSummary', () => {
  it('reads document.name when present', () => {
    const summary = extractWorkflowSummary(
      file('release.yaml', 'document:\n  name: Release Pipeline\ndo: []\n'),
    );
    expect(summary.id as string).toBe('release.yaml');
    expect(summary.name).toBe('Release Pipeline');
  });

  it('falls back to the filename basename when YAML has no document.name', () => {
    const summary = extractWorkflowSummary(
      file('demo.yaml', 'document:\n  version: "1.0"\ndo: []\n'),
    );
    expect(summary.name).toBe('demo');
  });

  it('falls back to the basename when document is missing entirely', () => {
    const summary = extractWorkflowSummary(file('demo.yml', 'do: []\n'));
    expect(summary.name).toBe('demo');
  });

  it('falls back to the basename when document.name is empty', () => {
    const summary = extractWorkflowSummary(
      file('demo.yaml', 'document:\n  name: ""\ndo: []\n'),
    );
    expect(summary.name).toBe('demo');
  });

  it('falls back to the basename when document.name is not a string', () => {
    const summary = extractWorkflowSummary(
      file('demo.yaml', 'document:\n  name: 42\ndo: []\n'),
    );
    expect(summary.name).toBe('demo');
  });

  it('falls back to the basename when the YAML cannot be parsed', () => {
    const summary = extractWorkflowSummary(
      file('broken.yaml', 'do: [unclosed\n'),
    );
    expect(summary.name).toBe('broken');
  });

  it('falls back to the basename when the YAML root is not a mapping', () => {
    const summary = extractWorkflowSummary(file('list-root.yaml', '- a\n- b\n'));
    expect(summary.name).toBe('list-root');
  });

  it('strips both .yaml and .yml in the fallback', () => {
    expect(extractWorkflowSummary(file('a.yaml', 'do: []\n')).name).toBe('a');
    expect(extractWorkflowSummary(file('b.yml', 'do: []\n')).name).toBe('b');
  });
});
