// src/ui/renderItems.ts
import type { StructuredPatchHunk } from 'diff';
import { computeHunks, extractEdits, isEditToolName } from './editDiff';
import type { ToolGroup } from './rows/ToolGroupRow';
import type { LogEntry } from './useEngineState';

type ToolUseEntry = Extract<LogEntry, { kind: 'tool-use' }>;
type ToolResultEntry = Extract<LogEntry, { kind: 'tool-result' }>;

interface RenderCommon {
  id: string;
  /** Animates the dot while true. Tied to unresolved tool calls only. */
  running: boolean;
  /**
   * Set when the resolved tool-result for this (single) tool-use or any use
   * in the group came back with is_error=true. Drives the static dot color
   * after completion (red vs green), mirroring claude-code's ToolUseLoader.
   */
  errored: boolean;
  /**
   * False if the item could still grow (e.g. a Read group with no terminator
   * after it yet). Open-ended items stay in the live region so they don't
   * get frozen at a stale size by <Static>.
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
       * Derived from `old_string` / `new_string` in the tool input, so the
       * diff is available the moment the tool-use arrives (no file read).
       */
      editHunks?: StructuredPatchHunk[];
    } & RenderCommon)
  | ({ kind: 'group'; group: ToolGroup } & RenderCommon);

// Collapse runs of ≥2 consecutive same-name tool-use entries (plus their
// matching tool-results that stream right after) into a single grouped render
// item. Mirrors claude-code's `applyGrouping` — parallel Reads / Greps from the
// same assistant turn render as one visual cluster so the running indicator
// is easy to spot instead of flickering across N near-simultaneous rows.
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
      // same-name reads could join and <Static> would snapshot the group
      // at a stale size.
      const committable = j < entries.length;
      const running = uses.some((u) => !resolvedIds.has(u.toolUseId));
      const errored = uses.some((u) => erroredIds.has(u.toolUseId));
      items.push({
        kind: 'group',
        id: `group-${entry.toolUseId}`,
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
    // Pre-compute Edit/MultiEdit/Write diffs so the row renders `⎿ +/-` lines
    // directly from the tool-use input — no file read required.
    const editHunks =
      entry.kind === 'tool-use' && isEditToolName(entry.name)
        ? computeHunks(extractEdits(entry.name, entry.input))
        : undefined;
    items.push({
      kind: 'entry',
      id: `log-${i}`,
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

export function renderItemBlocksCommit(item: RenderItem): boolean {
  // A running item can't be committed (it's still animating), and a
  // not-yet-committable item could still grow — both must stay in live.
  return item.running || !item.committable;
}

/**
 * Split render items at the first one that must stay live (running or still
 * growing). Everything before is settled history (safe to freeze into
 * <Static>), everything from there on stays in the live region.
 */
export function splitAtLiveBoundary(entries: LogEntry[]): {
  staticItems: RenderItem[];
  liveItems: RenderItem[];
} {
  const resolvedIds = new Set<string>();
  const erroredIds = new Set<string>();
  // tool-result ids for Edit-family tool-uses — their result text is replaced
  // by the inline diff so we don't need to render it as a separate row.
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

  const staticItems: RenderItem[] = [];
  for (let i = 0; i < cut; i++) {
    const item = items[i];
    if (item) staticItems.push(item);
  }
  const liveItems = items.slice(cut);
  return { staticItems, liveItems };
}
