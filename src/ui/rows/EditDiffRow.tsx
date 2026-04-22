import type { StructuredPatchHunk } from 'diff';
import { Text } from 'ink';
import type { ReactElement } from 'react';
import { countChanges } from '../editDiff';
import { theme } from '../theme';
import { ResultGutter } from './ResultGutter';

// Maximum lines rendered per hunk before we fall back to a "… +N lines" line.
// claude-code wraps via terminal width; here we cap per-hunk so absurdly long
// replacements don't blow up the log.
const MAX_LINES_PER_HUNK = 40;

function markerColor(marker: string): string | undefined {
  if (marker === '+') return theme.done;
  if (marker === '-') return theme.error;
  return theme.dim;
}

/**
 * Renders an Edit/MultiEdit/Write patch under the ⎿ gutter, one `+`/`-`/` `
 * line per row. Header reads `Added N lines, removed M lines` — matches
 * claude-code's FileEditToolUpdatedMessage.
 */
export function EditDiffRow({ hunks }: { hunks: StructuredPatchHunk[] }): ReactElement | null {
  if (hunks.length === 0) return null;
  const { added, removed } = countChanges(hunks);

  const body: { marker: string; text: string }[] = [];
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    if (!hunk) continue;
    if (h > 0) body.push({ marker: ' ', text: '...' });
    const lines = hunk.lines;
    const shown = lines.slice(0, MAX_LINES_PER_HUNK);
    for (const line of shown) {
      body.push({ marker: line[0] ?? ' ', text: line.slice(1) });
    }
    const hidden = lines.length - shown.length;
    if (hidden > 0) {
      body.push({ marker: ' ', text: `… +${hidden} line${hidden === 1 ? '' : 's'}` });
    }
  }

  const summary = buildSummary(added, removed);

  return (
    <ResultGutter>
      {summary ? <Text color={theme.dim}>{summary}</Text> : null}
      {body.map((row, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: deterministic split of patch lines
        <Text key={`edit-${idx}`} color={markerColor(row.marker)}>
          {row.marker} {row.text}
        </Text>
      ))}
    </ResultGutter>
  );
}

function buildSummary(added: number, removed: number): string | null {
  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${added} ${added === 1 ? 'line' : 'lines'}`);
  if (removed > 0) {
    const prefix = added > 0 ? 'removed' : 'Removed';
    parts.push(`${prefix} ${removed} ${removed === 1 ? 'line' : 'lines'}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}
