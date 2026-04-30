// User-visible strings for the "Run Workflow" trigger
// (`apps/web/docs/scenarios/workflow-editor/run-workflow.md`). Mirrors the
// pattern used by `recentRunsCopy.ts` / `runDetailCopy.ts` so a future i18n
// migration can be a localised search-and-replace.

export const runWorkflowCopy = {
  /** Label rendered next to the play icon on the trigger button. */
  triggerLabel: 'Run',
  /** Label shown while the start-run POST is in flight. */
  triggerBusyLabel: 'Starting…',
  /**
   * Accessible name for the icon-and-text button. Read aloud by screen
   * readers; the visible text is identical so the cue is consistent.
   */
  triggerAria: 'Start a new run of this workflow',
  /**
   * Toast/inline success message. Producing the text via a template lets a
   * future locale rearrange the run id without leaking layout into the
   * call-site (mirrors `editorCopy.insertedTemplate`).
   */
  startedTemplate: (runId: string) => `Run started: ${String(runId)}`,
  /** Generic fallback when the API call failed for an unmapped reason. */
  errorState: 'Failed to start run',
} as const;

export type RunWorkflowCopy = typeof runWorkflowCopy;
