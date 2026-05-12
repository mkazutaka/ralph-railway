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
