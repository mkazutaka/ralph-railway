// User-visible strings for the "Test Node" panel
// (`apps/web/docs/scenarios/workflow-editor/test-node.md`). Mirrors the
// pattern used by `runWorkflowCopy.ts` / `stopRunCopy.ts` /
// `runDetailCopy.ts` so a future i18n migration is a localised
// search-and-replace.
//
// Review note (review-frontend.md, m-1): unused copy fields previously
// declared as i18n placeholders (`regionAria`, `errorState`,
// `resultStatusLabel`, `resultDurationLabel`, `noLogs`) were removed —
// every key in this object is now read by `TestNodePanel.svelte`.

export const testNodeCopy = {
  /** Section heading rendered above the panel content. Mirrors the
   * `Test Step` label in the design's Right Panel (`SV10l`). */
  sectionTitle: 'TEST NODE',
  /**
   * Helper text shown when the user has not entered a node id yet. Mentions
   * the scenario invariant 1 explicitly (review note M-1) so the user knows
   * the test won't appear in the Recent Runs panel above.
   */
  emptyState:
    'Enter the id of a `run` or `set` node to execute it in isolation against dummy inputs. Test runs do not appear in Recent Runs.',
  /** Label for the node id input. */
  nodeIdLabel: 'Node ID',
  /** Placeholder hint for the node id input. */
  nodeIdPlaceholder: 'e.g. build',
  /** Label for the dummy inputs section (mirrors design `I1eiP`). */
  inputsLabel: 'Dummy inputs (.with)',
  /**
   * Helper caption shown under the inputs editor. Updated per review notes
   * m-1 / m-5: values are forwarded as plain strings, and validation only
   * fires when the node declares a `with:` schema — for declaration-free
   * nodes (e.g. a plain `run: { shell: ... }`) the server accepts any
   * inputs, so we avoid implying "always validated" copy.
   *
   * ASCII straight quote (`'`) is used intentionally (review note m-5) so
   * a future i18n grep / search-and-replace does not have to match both
   * the curly (`’`) and straight forms.
   */
  inputsHelper:
    "Values are forwarded as strings. If the node declares a `with:` schema, the server validates inputs before running it.",
  /** Placeholder text for an empty key/value row. */
  inputsKeyPlaceholder: 'key',
  inputsValuePlaceholder: 'value',
  /** Add-row button label. */
  addInputLabel: 'Add input',
  /** Remove-row button label (used as aria-label on the icon button). */
  removeInputAria: 'Remove this input',
  /** Trigger button label (mirrors design `lUoxm` "Test Step"). */
  triggerLabel: 'Test Step',
  /** Label shown while the test request is in flight. */
  triggerBusyLabel: 'Testing…',
  /** Accessible name for the trigger when no node id has been entered. */
  triggerAria: 'Run an isolated test of the entered node',
  /** Section labels inside the result block. */
  resultHeading: 'Result',
  resultOutputLabel: 'Output',
  resultErrorLabel: 'Error',
  resultLogLabel: 'Log excerpt',
  /** Empty caption when the node produced no output. */
  noOutput: 'No output produced.',
  /**
   * Footnote shown inside the result section reinforcing scenario invariant
   * 1 (review note M-1). Lets the user trust that what they just ran did
   * not pollute the Recent Runs list.
   */
  noPersistNote: 'Test runs are not added to Recent Runs.',
  /** Accessible name for the node id `<datalist>` (review note M-2). */
  nodeIdSuggestionsAria: 'Available node ids in this workflow',
} as const;

export type TestNodeCopy = typeof testNodeCopy;
