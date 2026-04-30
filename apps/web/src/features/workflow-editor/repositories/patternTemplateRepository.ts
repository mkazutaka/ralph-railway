import type { PatternTemplate } from '../entities/pattern';
import type { PatternId } from '../entities/types';
import { asPatternId } from '../entities/types';

export type LoadPatternTemplateResult =
  | { kind: 'loaded'; template: PatternTemplate }
  | { kind: 'unknown' }
  | { kind: 'unsupported' };

export type LoadPatternTemplate = (id: PatternId) => Promise<LoadPatternTemplateResult>;
export type ListPatternTemplates = () => ReadonlyArray<PatternTemplate>;

export interface PatternTemplateRepository {
  loadPatternTemplate: LoadPatternTemplate;
  listPatternTemplates: ListPatternTemplates;
}

// Built-in pattern showcase. The `supported` flag mirrors the runtime's
// current capability matrix; unsupported entries are still listed in the UI
// (so users can preview them) but are rejected at insertion time per the
// scenario's invariant 3.
const PATTERN_REGISTRY: ReadonlyArray<PatternTemplate> = [
  {
    id: asPatternId('do'),
    label: 'do (sequence)',
    description: 'Execute the contained tasks in order.',
    supported: true,
    tasks: [
      {
        sample_step: {
          run: { shell: { command: 'echo hello' } },
        },
      },
    ],
  },
  {
    id: asPatternId('if'),
    label: 'if (guard)',
    description: 'Run the task only when the condition holds.',
    supported: true,
    tasks: [
      {
        guarded_step: {
          if: '${ true }',
          run: { shell: { command: 'echo guarded' } },
        },
      },
    ],
  },
  {
    id: asPatternId('switch'),
    label: 'switch (route)',
    description: 'Route execution based on a value.',
    supported: true,
    tasks: [
      {
        route_step: {
          switch: {
            on: '${ .var.kind }',
            cases: [
              { when: 'a', do: 'handle_a' },
              { when: 'b', do: 'handle_b' },
            ],
          },
        },
      },
    ],
  },
  {
    id: asPatternId('fork'),
    label: 'fork (parallel)',
    description: 'Run multiple branches in parallel and merge results.',
    supported: false,
    tasks: [
      {
        parallel_step: {
          fork: {
            branches: [
              { do: [{ branch_a: { run: { shell: { command: 'echo a' } } } }] },
              { do: [{ branch_b: { run: { shell: { command: 'echo b' } } } }] },
            ],
          },
        },
      },
    ],
  },
  {
    id: asPatternId('loop'),
    label: 'loop (for-each)',
    description: 'Iterate over a list of values.',
    supported: true,
    tasks: [
      {
        loop_step: {
          for: { each: 'item', in: '${ .var.items }' },
          do: [{ inner_step: { run: { shell: { command: 'echo ${ .var.item }' } } } }],
        },
      },
    ],
  },
  {
    id: asPatternId('try'),
    label: 'try / catch',
    description: 'Recover from a failing task.',
    supported: false,
    tasks: [
      {
        guarded_run: {
          try: { do: [{ risky: { run: { shell: { command: 'false' } } } }] },
          catch: { do: [{ recover: { run: { shell: { command: 'echo recovered' } } } }] },
        },
      },
    ],
  },
  {
    id: asPatternId('retry'),
    label: 'retry (backoff)',
    description: 'Retry a task with exponential backoff.',
    supported: false,
    tasks: [
      {
        flaky_step: {
          retry: { max: 3, backoff: 'exponential' },
          run: { shell: { command: 'curl https://example.test' } },
        },
      },
    ],
  },
  {
    id: asPatternId('set'),
    label: 'set (assign)',
    description: 'Assign computed values to outputs.',
    supported: true,
    tasks: [
      {
        assign_step: {
          set: { greeting: '${ "hello, " + .var.name }' },
        },
      },
    ],
  },
];

export function toPatternTemplateRepository(): PatternTemplateRepository {
  const byId = new Map<string, PatternTemplate>();
  for (const t of PATTERN_REGISTRY) byId.set(t.id, t);

  return {
    async loadPatternTemplate(id) {
      const tpl = byId.get(id);
      if (!tpl) return { kind: 'unknown' };
      if (!tpl.supported) return { kind: 'unsupported' };
      return { kind: 'loaded', template: tpl };
    },
    listPatternTemplates() {
      return PATTERN_REGISTRY;
    },
  };
}
