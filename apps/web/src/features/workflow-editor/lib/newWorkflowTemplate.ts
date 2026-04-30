// Default YAML scaffold used by the new-workflow page (`routes/workflows/new`).
//
// Lives in the feature module rather than inline in the route so the same
// template can be reused by future entry points (CLI scaffolders, seed
// fixtures) and so review note m-5 — "the create page hard-codes a `set:`
// pattern that may end up `unsupportedPattern` in the future" — is addressed
// in one place. The body is intentionally tiny: a valid `do:` list with a
// single `set` task that exercises the merge path immediately so a fresh
// workflow already passes `parseWorkflowYaml` and `yamlToFlow` without the
// user touching the buffer.
//
// We pick `set` (variable assignment) over `do` because:
//   - It's universally supported by the runtime registry today (`supported:
//     true` in the fixtures).
//   - It demonstrates `${...}` substitution syntax in the value position.
//   - The pattern picker also offers `set` so the user immediately has a
//     mental anchor between the create scaffold and the picker palette.

export const NEW_WORKFLOW_DEFAULT_ID = 'untitled.yaml';

export const NEW_WORKFLOW_DEFAULT_YAML = `document:
  dsl: '1.0.0'
  namespace: default
  name: untitled
  version: '0.1.0'
do:
  - first:
      set:
        message: 'hello'
`;
