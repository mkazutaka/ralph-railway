import { type StructuredPatchHunk, structuredPatch } from 'diff';
import { Text } from 'ink';
import type { ReactElement } from 'react';
import { theme } from '../utils/theme';
import { ResultGutter } from './ResultGutter';

// Maximum lines rendered per hunk before we fall back to a "… +N lines" line.
// claude-code wraps via terminal width; here we cap per-hunk so absurdly long
// replacements don't blow up the log.
const MAX_LINES_PER_HUNK = 40;

interface EditLike {
  old_string: string;
  new_string: string;
}

// Tools whose input carries enough info to render a local diff without
// reading the target file.
export function isEditToolName(name: string): boolean {
  return name === 'Edit' || name === 'MultiEdit' || name === 'Write';
}

export function extractEdits(name: string, input: Record<string, unknown>): EditLike[] {
  if (name === 'Edit') {
    const oldStr = input.old_string;
    const newStr = input.new_string;
    if (typeof oldStr === 'string' && typeof newStr === 'string') {
      return [{ old_string: oldStr, new_string: newStr }];
    }
    return [];
  }
  if (name === 'MultiEdit') {
    const edits = input.edits;
    if (!Array.isArray(edits)) return [];
    const out: EditLike[] = [];
    for (const raw of edits) {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { old_string?: unknown }).old_string === 'string' &&
        typeof (raw as { new_string?: unknown }).new_string === 'string'
      ) {
        out.push({
          old_string: (raw as { old_string: string }).old_string,
          new_string: (raw as { new_string: string }).new_string,
        });
      }
    }
    return out;
  }
  if (name === 'Write') {
    // Pure-addition diff — full new file with `+` markers.
    const content = input.content;
    if (typeof content === 'string') return [{ old_string: '', new_string: content }];
    return [];
  }
  return [];
}

// Concatenate edits for MultiEdit so one patch covers every replacement.
export function computeHunks(edits: EditLike[]): StructuredPatchHunk[] {
  if (edits.length === 0) return [];
  const oldJoined = edits.map((e) => e.old_string).join('\n');
  const newJoined = edits.map((e) => e.new_string).join('\n');
  const patch = structuredPatch('a', 'b', oldJoined, newJoined, '', '', { context: 3 });
  return patch.hunks;
}

function countChanges(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

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
