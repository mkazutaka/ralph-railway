export const MAX_LINE_COLS = 120;
// Mirrors claude-code's MAX_LINES_TO_SHOW — tool-result shows up to 3 wrapped
// lines, anything beyond collapses to a "… +N lines" summary.
export const MAX_RESULT_LINES = 3;
// PADDING_TO_PREVENT_OVERFLOW in claude-code: body wraps at terminal width
// minus the "  ⎿  " gutter plus a safety margin.
export const RESULT_WRAP_COLS = MAX_LINE_COLS - 5;
