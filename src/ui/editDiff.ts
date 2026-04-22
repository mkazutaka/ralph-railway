// src/ui/editDiff.ts
import { type StructuredPatchHunk, structuredPatch } from 'diff';

export interface EditLike {
  old_string: string;
  new_string: string;
}

/**
 * Tools whose tool-use input carries enough information to render a local
 * diff without reading the target file. Matches claude-code's
 * `renderToolUseMessage` which inspects the same set and produces the same
 * kind of inline diff output.
 */
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
    const content = input.content;
    if (typeof content === 'string') {
      // Rendered as a pure-addition diff so the user sees the full new file
      // with `+` markers. Same visual as claude-code's Write display.
      return [{ old_string: '', new_string: content }];
    }
    return [];
  }
  return [];
}

/**
 * Compute unified-diff hunks for an Edit/MultiEdit/Write invocation. For
 * MultiEdit, edits are concatenated before diffing so one patch covers every
 * replacement (mirrors claude-code's `getPatchForDisplay` for the "single-edit
 * inputs-only" branch). Context lines default to 3, same as the API.
 */
export function computeHunks(edits: EditLike[]): StructuredPatchHunk[] {
  if (edits.length === 0) return [];
  const oldJoined = edits.map((e) => e.old_string).join('\n');
  const newJoined = edits.map((e) => e.new_string).join('\n');
  const patch = structuredPatch('a', 'b', oldJoined, newJoined, '', '', { context: 3 });
  return patch.hunks;
}

/**
 * Count `+` / `-` lines across all hunks for the "Added N lines, removed M
 * lines" header.
 */
export function countChanges(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
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
