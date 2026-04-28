/**
 * Compact preview of a tool-use block's inputs. Picks the most
 * characteristic field for common built-in tools (Bash command, Read path,
 * Grep pattern, etc.) and falls back to a truncated JSON blob otherwise.
 */
export function inputPreview(name: string, input: Record<string, unknown>): string {
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash':
      return s('command');
    case 'Read':
    case 'Edit':
    case 'Write':
      return s('file_path') || s('path');
    case 'Grep':
    case 'Glob':
      return s('pattern');
    case 'WebFetch':
    case 'WebSearch':
      return s('url') || s('query');
    case 'Task':
      return s('description') || s('prompt');
    default:
      return Object.keys(input).length > 0 ? JSON.stringify(input).slice(0, 80) : '';
  }
}

/**
 * Split text into the last N non-empty lines, each clamped to maxCols chars.
 * Preserves line breaks so multi-line reasoning (thinking blocks) stays
 * readable instead of being crushed into one line.
 */
export function textLastLines(text: string, maxLines = 4, maxCols = 120): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines
    .slice(-maxLines)
    .map((l) => (l.length > maxCols ? `${l.slice(0, maxCols - 1)}…` : l));
}
