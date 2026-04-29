import { readFileSync } from 'node:fs';
import { Classes, type Specification, validate } from '@serverlessworkflow/sdk';
import { load as yamlLoad } from 'js-yaml';
import { expandArgs } from './args';

export type Workflow = Specification.Workflow;

/**
 * Read, schema-validate, and hydrate a workflow YAML — without applying any
 * runtime argument expansion. Use this when you only need to verify that a
 * file conforms to the SLW v1.0.3 schema (e.g. the `validate` subcommand).
 */
export function parseWorkflow(path: string): Workflow {
  const text = readFileSync(path, 'utf-8');
  const raw = yamlLoad(text);
  validate('Workflow', raw);
  return new Classes.Workflow(raw as unknown as Partial<Workflow>) as unknown as Workflow;
}

/**
 * Load, schema-validate, and hydrate a workflow YAML, then expand
 * `<ARGUMENTS>` / `<N>` placeholder tokens inside string values using the
 * supplied positional CLI arguments.
 *
 * Schema validation is performed by @serverlessworkflow/sdk against SLW v1.0.3.
 * All tasks must conform to the spec (set / call / for / switch / fork / try / do);
 * legacy ralph-railway extensions such as a top-level `while:` task are rejected.
 * Loop semantics use `for.while` per the spec.
 *
 * @throws {WorkflowValidationError} when `<ARGUMENTS>`/`<N>` tokens are
 *   inconsistent with `args` (see `expandArgs` for the exact conditions).
 */
export function loadWorkflow(path: string, args: readonly string[] = []): Workflow {
  const wf = parseWorkflow(path);
  expandArgs(wf, args);
  return wf;
}
