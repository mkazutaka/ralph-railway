// Copy strings for the Workflow List index. Centralised here so the page
// component stays presentational and the strings can be referenced from
// E2E tests without coupling to JSX-style template literals.
//
// See `apps/web/docs/scenarios/workflow-management/list-workflows.md`:
// - Invariant 1: zero-workflow case is a normal empty list (NOT an error).
// - Invariant 2: every WorkflowSummary has a Name (filename fallback).
export const workflowListCopy = {
  pageHeading: 'Workflows',
  newAction: 'New',
  // Empty-state — invariant 1 in the scenario explicitly forbids modelling
  // "no workflows" as a failure, so the copy reads as a friendly nudge
  // (drop a file, or create one) rather than an error.
  emptyTitle: 'No workflows yet',
  emptyHint:
    'Drop a .yaml file in the configured directory, or click New to create one.',
  // a11y label for the workflow list region.
  listAria: 'Workflow list',
  openAction: 'Open',
} as const;
