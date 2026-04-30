import { describe, expect, it } from 'vitest';
import { asPatternId, asWorkflowId, asYamlSource } from '../entities/types';
import { insertPatternWorkflow } from './insertPatternWorkflow';
import type { LoadPatternTemplate } from '../repositories/patternTemplateRepository';
import type { ReadWorkflowFile, WriteWorkflowFile } from '../repositories/workflowFileRepository';
import type { PatternTemplate } from '../entities/pattern';
import {
  mergePatternIntoDocument,
  parseWorkflowYaml,
  serializeYaml,
  type MergePatternResult,
} from '../lib/yaml';

const validBase = asYamlSource(
  'document:\n  name: demo\ndo:\n  - existing:\n      set:\n        n: 1\n',
);

const setPattern: PatternTemplate = {
  id: asPatternId('set'),
  label: 'set',
  description: '',
  supported: true,
  tasks: [{ assign_step: { set: { foo: 'bar' } } }],
};

function makeDeps(overrides: {
  read?: ReadWorkflowFile;
  load?: LoadPatternTemplate;
  write?: WriteWorkflowFile;
}) {
  const writes: Array<{ id: string; yaml: string }> = [];
  const deps = {
    readWorkflowFile: overrides.read ?? (async () => ({ kind: 'found', yaml: validBase }) as const),
    loadPatternTemplate:
      overrides.load ?? (async () => ({ kind: 'loaded', template: setPattern }) as const),
    writeWorkflowFile:
      overrides.write ??
      (async (id, yaml) => {
        writes.push({ id, yaml });
        return { kind: 'written' } as const;
      }),
    parseWorkflowYaml,
    mergePatternIntoDocument,
    serializeYaml,
  };
  return { deps, writes };
}

describe('insertPatternWorkflow', () => {
  it('returns workflowNotFound when the base workflow is missing', async () => {
    const { deps } = makeDeps({ read: async () => ({ kind: 'notFound' }) });
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      deps,
    );
    expect(out.kind).toBe('workflowNotFound');
  });

  it('returns unknownPattern when the pattern is not registered', async () => {
    const { deps } = makeDeps({ load: async () => ({ kind: 'unknown' }) });
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('nope') },
      deps,
    );
    expect(out.kind).toBe('unknownPattern');
  });

  it('returns unsupportedPattern for runtime-unsupported patterns', async () => {
    const { deps } = makeDeps({ load: async () => ({ kind: 'unsupported' }) });
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('fork') },
      deps,
    );
    expect(out.kind).toBe('unsupportedPattern');
  });

  it('returns invalidBaseYaml when the base YAML cannot be parsed', async () => {
    const { deps } = makeDeps({
      read: async () => ({ kind: 'found', yaml: asYamlSource('do: [unclosed\n') }),
    });
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      deps,
    );
    expect(out.kind).toBe('invalidBaseYaml');
  });

  it('returns idConflict when merge cannot allocate a unique id', async () => {
    const { deps } = makeDeps({});
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      {
        ...deps,
        mergePatternIntoDocument: (): MergePatternResult => ({ kind: 'idConflict' }),
      },
    );
    expect(out.kind).toBe('idConflict');
  });

  it('returns templateMalformed when a pattern entry is missing a single key', async () => {
    const { deps } = makeDeps({});
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      {
        ...deps,
        mergePatternIntoDocument: (): MergePatternResult => ({
          kind: 'templateMalformed',
          reason: 'pattern entry must have exactly one key (got 2)',
        }),
      },
    );
    expect(out.kind).toBe('templateMalformed');
  });

  it('returns persistFailed when the write rejects the id', async () => {
    const { deps } = makeDeps({
      write: async () => ({ kind: 'invalidId', reason: 'invalid extension: a.txt' }),
    });
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      deps,
    );
    expect(out.kind).toBe('persistFailed');
  });

  it('returns templateMalformed when the merged YAML fails to re-parse (invariant 1 safety net)', async () => {
    // Simulate a future regression where merge or serialize emits something
    // that the parser would refuse on the next read. The workflow must not
    // commit such a file to disk; it must surface this as a server-side bug
    // (templateMalformed → HTTP 500) so the user retains a working file.
    const writes: Array<{ id: string; yaml: string }> = [];
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      {
        readWorkflowFile: async () => ({ kind: 'found', yaml: validBase }),
        loadPatternTemplate: async () => ({ kind: 'loaded', template: setPattern }),
        writeWorkflowFile: async (id, yaml) => {
          writes.push({ id, yaml });
          return { kind: 'written' };
        },
        parseWorkflowYaml,
        mergePatternIntoDocument,
        // Force the post-merge YAML to be syntactically broken — only the
        // safety re-parse can catch this; the merge step succeeds normally.
        serializeYaml: () => asYamlSource('do: [unclosed\n'),
      },
    );
    expect(out.kind).toBe('templateMalformed');
    // Critical: the bad YAML must NOT have been persisted.
    expect(writes).toHaveLength(0);
  });

  it('persists the merged YAML and returns patternInserted on success', async () => {
    const { deps, writes } = makeDeps({});
    const out = await insertPatternWorkflow(
      { workflowId: asWorkflowId('a.yaml'), patternId: asPatternId('set') },
      deps,
    );
    expect(out.kind).toBe('patternInserted');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.id).toBe('a.yaml');
    expect(writes[0]!.yaml).toContain('assign_step');
    expect(writes[0]!.yaml).toContain('existing');
  });
});
