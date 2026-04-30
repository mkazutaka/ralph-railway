// User-visible strings for the "Stop Run" trigger
// (`apps/web/docs/scenarios/workflow-editor/stop-run.md`). Mirrors the pattern
// used by `runWorkflowCopy.ts` / `recentRunsCopy.ts` / `runDetailCopy.ts` so a
// future i18n migration is a localised search-and-replace.

export const stopRunCopy = {
  /** Label rendered next to the stop icon on the trigger button. */
  triggerLabel: 'Stop',
  /** Label shown while the stop POST is in flight. */
  triggerBusyLabel: 'Stopping…',
  /**
   * Accessible name for the icon-and-text button. Read aloud by screen
   * readers; the visible text is identical so the cue is consistent with
   * the Run trigger.
   */
  triggerAria: 'Request that this run be stopped',
  /**
   * Inline success caption shown next to the button after the runtime has
   * accepted the request. Scenario invariants 2 & 3 say the request is
   * asynchronous and the actual `Cancelled` transition is observed via the
   * read-run-detail endpoint — so the copy explicitly signals "requested",
   * not "stopped". The user reads the eventual outcome from the run-detail
   * panel that re-fetches after this success.
   */
  acceptedLabel: 'Stop requested',
  /** Generic fallback when the API call failed for an unmapped reason. */
  errorState: 'Failed to stop run',
} as const;

export type StopRunCopy = typeof stopRunCopy;
