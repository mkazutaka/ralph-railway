// User-visible strings for the "Create Workflow" form
// (`apps/web/docs/scenarios/workflow-management/create-workflow.md`). Mirrors
// the pattern used by `runWorkflowCopy.ts` so a future i18n migration can
// be a localised search-and-replace.

export const createWorkflowCopy = {
  /** Page heading rendered above the form. */
  heading: 'New workflow',
  /** Caption sitting under the heading; describes the scenario in one line. */
  subheading:
    'Pick a unique file name and seed the buffer with a valid YAML document. The editor opens after the file is created.',
  /** Label for the workflow id (file name) input. */
  fileNameLabel: 'File name',
  /**
   * Help caption rendered below the file-name input. Calls out the brand
   * regex constraints so the user can self-correct the most common typos
   * (review-style guidance baked into the UI text).
   */
  fileNameHelp: 'Must end with .yaml or .yml. Letters, digits, dot, dash, underscore only.',
  /** Label for the YAML buffer textarea. */
  yamlLabel: 'YAML',
  /** Help caption rendered below the YAML buffer. */
  yamlHelp: 'Must be a valid Workflow DSL document. Invalid YAML is rejected before write.',
  /** Idle label for the primary submit button. */
  submitLabel: 'Create',
  /** Label shown while the create POST is in flight. */
  submitBusyLabel: 'Creating…',
  /** Label for the secondary "back to list" link button. */
  cancelLabel: 'Cancel',
  /** Heading text used on the inline error alert region. */
  errorHeading: 'Could not create workflow',
} as const;

export type CreateWorkflowCopy = typeof createWorkflowCopy;
