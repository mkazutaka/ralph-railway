// src/ui/renderItems.ts
import type { StructuredPatchHunk } from 'diff';
import { computeHunks, extractEdits, isEditToolName } from './editDiff';
import type { ToolGroup } from './rows/ToolGroupRow';
import type { LogEntry } from './useEngineState';

type ToolUseEntry = Extract<LogEntry, { kind: 'tool-use' }>;
type ToolResultEntry = Extract<LogEntry, { kind: 'tool-result' }>;

interface RenderCommon {
  id: string;
  /** Exclusive index in the source LogEntry array consumed by this item. */
  sourceEnd: number;
  /** Animates the dot while true. Tied to unresolved tool calls only. */
  running: boolean;
  /**
   * Set when a tool-result for this (single) tool-use or any use in the group
   * came back with isError=true. Drives the dot color (red vs green) once the
   * call completes, mirroring claude-code's ToolUseLoader.
   */
  errored: boolean;
  /**
   * False if the item could still grow (e.g. a Read group with no terminator
   * after it yet). Open-ended items must stay live so they don't get committed
   * to scrollback at a stale size.
   */
  committable: boolean;
  marginBottom: 0 | 1;
}

export type RenderItem =
  | ({
      kind: 'entry';
      entry: LogEntry;
      /**
       * Pre-computed unified-diff hunks for Edit/MultiEdit/Write tool-uses.
       * Derived from `old_string`/`new_string` in the tool input so the diff
       * is available the moment the tool-use arrives — no file read required.
       */
      editHunks?: StructuredPatchHunk[];
    } & RenderCommon)
  | ({ kind: 'group'; group: ToolGroup } & RenderCommon);

// Collapse runs of ≥2 consecutive same-name tool-use entries (plus their
// matching tool-results that stream right after) into a single grouped render
// item. Mirrors claude-code's `applyGrouping` — parallel Reads / Greps from the
// same assistant turn render as one visual cluster so the running indicator is
// easy to spot instead of flickering across N near-simultaneous rows.
export function buildRenderItems(
  entries: LogEntry[],
  resolvedIds: Set<string>,
  erroredIds: Set<string>,
  absorbedResultIds: Set<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (!entry) {
      i++;
      continue;
    }
    // tool-result entries that correspond to an Edit/MultiEdit/Write tool-use
    // are absorbed into the inline diff — skip emitting them as separate rows.
    if (entry.kind === 'tool-result' && absorbedResultIds.has(entry.toolUseId)) {
      i++;
      continue;
    }
    // Only Read collapses into a group — parallel reads are common and noisy,
    // while Bash/Edit clusters stay readable as individual rows.
    if (entry.kind === 'tool-use' && entry.name === 'Read') {
      // Scan forward allowing tool-results for already-seen ids to interleave.
      // Read frequently resolves between sibling calls, so pure-adjacency
      // grouping would miss them.
      const uses: ToolUseEntry[] = [entry];
      const results = new Map<string, ToolResultEntry>();
      const ids = new Set<string>([entry.toolUseId]);
      let j = i + 1;
      while (j < entries.length) {
        const nxt = entries[j];
        if (nxt?.kind === 'tool-use' && nxt.name === entry.name) {
          uses.push(nxt);
          ids.add(nxt.toolUseId);
          j++;
          continue;
        }
        if (nxt?.kind === 'tool-result' && ids.has(nxt.toolUseId)) {
          results.set(nxt.toolUseId, nxt);
          j++;
          continue;
        }
        break;
      }
      // "committable" only once a terminator follows — otherwise more
      // same-name reads could join later and a snapshot would freeze the group
      // at a stale size.
      const committable = j < entries.length;
      const running = uses.some((u) => !resolvedIds.has(u.toolUseId));
      const errored = uses.some((u) => erroredIds.has(u.toolUseId));
      items.push({
        kind: 'group',
        id: `group-${entry.toolUseId}`,
        sourceEnd: j,
        group: { name: entry.name, uses, results },
        running,
        errored,
        committable,
        marginBottom: 1,
      });
      i = j;
      continue;
    }
    const next = entries[i + 1];
    const glued = entry.kind === 'tool-use' && next?.kind === 'tool-result';
    const running = entry.kind === 'tool-use' && !resolvedIds.has(entry.toolUseId);
    const errored = entry.kind === 'tool-use' && erroredIds.has(entry.toolUseId);
    const editHunks =
      entry.kind === 'tool-use' && isEditToolName(entry.name)
        ? computeHunks(extractEdits(entry.name, entry.input))
        : undefined;
    const sourceEnd =
      entry.kind === 'tool-use' &&
      next?.kind === 'tool-result' &&
      next.toolUseId === entry.toolUseId &&
      absorbedResultIds.has(next.toolUseId)
        ? i + 2
        : i + 1;
    items.push({
      kind: 'entry',
      id: `log-${i}`,
      sourceEnd,
      entry,
      running,
      errored,
      committable: true,
      marginBottom: glued ? 0 : 1,
      editHunks,
    });
    i++;
  }
  return items;
}

function renderItemBlocksCommit(item: RenderItem): boolean {
  // A running item can't be committed (still animating), and a not-yet-
  // committable item could still grow — both must stay in the live region.
  return item.running || !item.committable;
}

/**
 * Split a LogEntry buffer at the first item that must stay live (running or
 * still growing). Everything before is settled history (safe to write into
 * scrollback); everything from there on stays in the live region. The caller
 * uses `commitEntryCount` to splice the consumed prefix out of its buffer.
 */
export function splitAtLiveBoundary(entries: LogEntry[]): {
  staticItems: RenderItem[];
  liveItems: RenderItem[];
  commitEntryCount: number;
} {
  const resolvedIds = new Set<string>();
  const erroredIds = new Set<string>();
  // tool-result ids whose Edit-family tool-use has its diff inlined — their
  // separate row is suppressed, but we still need to splice them out of the
  // source buffer once the prefix is committed.
  const absorbedResultIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'tool-result') {
      resolvedIds.add(e.toolUseId);
      if (e.isError) erroredIds.add(e.toolUseId);
      // Only absorb successful Edit/MultiEdit/Write results — failed ones
      // carry the error message we want to surface.
      if (!e.isError && isEditToolName(e.name)) absorbedResultIds.add(e.toolUseId);
    }
  }
  const items = buildRenderItems(entries, resolvedIds, erroredIds, absorbedResultIds);
  const boundary = items.findIndex(renderItemBlocksCommit);
  const cut = boundary === -1 ? items.length : boundary;

  const staticItems: RenderItem[] = items.slice(0, cut);
  const liveItems: RenderItem[] = items.slice(cut);

  let commitEntryCount = staticItems[staticItems.length - 1]?.sourceEnd ?? 0;
  // Trailing absorbed tool-results that fell after the last static item must
  // also be spliced; they have no row of their own but still occupy a slot
  // in the source buffer.
  while (
    commitEntryCount < entries.length &&
    entries[commitEntryCount]?.kind === 'tool-result' &&
    absorbedResultIds.has(
      (entries[commitEntryCount] as ToolResultEntry).toolUseId,
    )
  ) {
    commitEntryCount++;
  }
  return { staticItems, liveItems, commitEntryCount };
}
