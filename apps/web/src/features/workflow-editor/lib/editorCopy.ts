// User-visible strings for the workflow editor page (parent of the pattern
// picker). Keeping them in one module makes a future i18n migration a
// search-and-replace away — `+page.svelte` and `editorState.svelte.ts` only
// import from here instead of inlining literals. Mirrors the convention
// established in `components/patternPickerCopy.ts`.

/*
 * `insertedTemplate` (review note M-2): producing the toast text via a
 * template function keeps the message catalog cohesive even when a future
 * locale needs a different word order — e.g. Japanese might want
 * `${patternId} を挿入しました` (suffix) instead of the English prefix.
 * Inlining `'Inserted ' + patternId` would have leaked layout into the
 * call-site, defeating the i18n migration story this module is meant to
 * support. We deliberately route the patternId through `String(...)` so a
 * non-string (defensive) input still produces a safe DOM text node.
 */
export const editorCopy = {
  saveLabel: 'Save',
  savingLabel: 'Saving…',
  saved: 'Saved',
  errorPrefix: 'Error: ',
  insertedTemplate: (patternId: string) => `Inserted ${String(patternId)}`,
  yamlAriaLabel: 'Workflow YAML',
  yamlErrorElementId: 'yaml-error',
  tooLarge: 'workflow YAML is too large (max 256 KiB)',
} as const;

export type EditorCopy = typeof editorCopy;
