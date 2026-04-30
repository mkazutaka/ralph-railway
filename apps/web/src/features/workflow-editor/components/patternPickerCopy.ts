// User-visible strings for the pattern picker. Keeping them in one module
// makes a future i18n migration a search-and-replace away — components only
// import from here instead of inlining literals.

export const patternPickerCopy = {
  triggerLabel: 'Add Node',
  triggerAria: 'Insert pattern',
  popupTitle: 'Add Node',
  closeAria: 'Close pattern picker',
  searchPlaceholder: 'Search nodes...',
  searchAria: 'Search patterns',
  sectionSuggested: 'SUGGESTED',
  emptyState: 'No patterns match',
  unsupportedSuffix: '(runtime not supported yet)',
  unsupportedBadge: 'SOON',
  listAria: 'Pattern showcase',
} as const;

export type PatternPickerCopy = typeof patternPickerCopy;
