// Bridge between the workflow editor page and the persistent Top Bar.
//
// The Top Bar (mirroring `Ht9Do` in `apps/web/design/app.pen`) renders the
// Save / "Saved" pill / Run controls — but those controls are inherently
// page-scoped: they target the workflow currently open in the editor route
// and bind to that page's `editorState.svelte.ts` instance. Putting the
// state shape inside `+layout.server.ts` would force the layout to know
// about the editor, and prop-drilling through `LayoutData` does not
// reactively update mid-session as the user types.
//
// Solution: the editor route registers a small reactive descriptor with
// the layout's TopBar via Svelte 5 `setContext`. The TopBar reads it via
// `getContext`. When no editor is mounted (e.g. on the index route or
// the "new workflow" route), the descriptor is `null` and the Top Bar
// falls back to chrome-only rendering (no Save / Run, breadcrumb stops at
// the `.agents/railways` root).
//
// The descriptor is intentionally minimal — it exposes only what the Top
// Bar needs to render. The page still owns the underlying `editorState`
// and the side-effect plumbing (POST /api/.../runs etc.); we hand the Top
// Bar a thin façade so the design-driven control surface stays in step
// with the in-page editor state without coupling the two files
// structurally.

import { getContext, setContext } from 'svelte';

/**
 * Save status the Top Bar's pill mirrors. `idle` shows nothing (the bar
 * has not yet observed a save round-trip); `saving` shows the spinner
 * variant on the Save button; `saved` shows the green "Saved" pill from
 * the design (`iCDRl` in `app.pen`); `error` shows a danger-tinted pill so
 * the user sees the outcome at the top of the chrome even if they were
 * scrolled away from the in-page error toast.
 */
export type TopBarSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Reactive descriptor the editor route hands to the Top Bar. Implemented
 * as a plain object with getters so the TopBar can read live values out
 * of the page's `$state` runes without us having to push updates through
 * a reactive store.
 *
 * Methods (`save`, `onRunStarted`) are stable references — the page must
 * not swap them between renders, otherwise the Top Bar would lose its
 * click handler mid-flight.
 */
export interface TopBarEditorBinding {
  /** Workflow id (full filename, e.g. `nextjs-todo.yaml`). */
  readonly workflowId: string;
  /** True while a save round-trip is in-flight; mirrors `editorState.saving`. */
  readonly saving: boolean;
  /** Save outcome the pill should reflect (see `TopBarSaveStatus`). */
  readonly saveStatus: TopBarSaveStatus;
  /** Persist the buffer. Stable reference. */
  save(): Promise<void> | void;
  /**
   * Notification hook fired by `RunWorkflowButton` after the runtime accepts
   * a run. The page wires this through to `selectedRunId` so the run-detail
   * panel auto-loads the freshly-minted run.
   */
  onRunStarted(runId: string): void;
  /**
   * Currently inspected run id (`null` when no run is selected). The
   * sidebar mounts the editor's interactive `RecentRuns` panel and reads
   * this getter so the run row's `aria-current` highlight stays in sync
   * with the right-column `RunDetail` panel — both surfaces ultimately
   * derive from this single page-owned `$state`. `undefined` when the
   * editor route does not opt into the sidebar-driven selection (older
   * embeds / tests); the sidebar then falls back to the read-only
   * `SidebarRecentRuns` footer.
   */
  readonly selectedRunId?: string | null;
  /**
   * Setter the sidebar's `RecentRuns` row click handler invokes when the
   * user picks a run. The page wires this to the same `$state` field that
   * backs `selectedRunId`. Stable reference (must not be swapped between
   * renders, otherwise the sidebar would lose its click handler).
   */
  setSelectedRunId?(runId: string | null): void;
}

const TOP_BAR_EDITOR_KEY = Symbol('top-bar-editor');

/**
 * Reactive container the layout installs and the editor route writes
 * into. The `value` field is backed by a `$state` rune so the Top Bar's
 * `$derived(holder.value)` re-runs whenever the editor route registers
 * or clears its binding.
 *
 * Identity of the holder itself is stable for the lifetime of the
 * layout component — only the inner `value` ever changes. This keeps
 * the context entry that the Top Bar resolves at construction time
 * pointing at the same object across navigations within the shell.
 */
export interface TopBarEditorHolder {
  value: TopBarEditorBinding | null;
}

/**
 * Install the holder on the layout's component tree. Called from
 * `+layout.svelte`. Must be invoked from a `.svelte` script (or a
 * `.svelte.ts` module reactive context) so the `$state` rune is legal.
 *
 * Returns the same reference so the layout can pass it down via context
 * AND optionally read from it (e.g. for SSR fallbacks).
 */
export function provideTopBarEditorHolder(): TopBarEditorHolder {
  // `$state` makes `holder.value` reactive: setting it from the editor
  // route's setup (or its `onDestroy` cleanup) automatically wakes the
  // Top Bar's `$derived(holder.value)` and re-renders the Save / Run
  // cluster without the layout having to push events through a separate
  // signal channel.
  let value = $state<TopBarEditorBinding | null>(null);
  const holder: TopBarEditorHolder = {
    get value() {
      return value;
    },
    set value(next) {
      value = next;
    },
  };
  setContext(TOP_BAR_EDITOR_KEY, holder);
  return holder;
}

/**
 * Read the holder from the surrounding component tree. Used by the
 * Top Bar to surface Save / Run controls and by editor pages to publish
 * their state via `getTopBarEditorHolder()`.
 *
 * MUST be called during component initialization (Svelte's `getContext`
 * contract). The Top Bar / editor page do this once at the top of their
 * `<script>` block and store the reference; reactive consumers then
 * read `holder.value` inside `$derived` without re-invoking
 * `getContext`.
 */
function readHolder(): TopBarEditorHolder | null {
  return getContext<TopBarEditorHolder | undefined>(TOP_BAR_EDITOR_KEY) ?? null;
}

/**
 * Convenience reader for the Top Bar. Resolves the holder at component
 * setup and returns its current `value`. Callers wrap the call in
 * `$derived(...)` so reads stay reactive — the holder's `value` is a
 * `$state`-backed getter, so accessing it inside a derivation registers
 * the dependency as expected.
 */
export function getTopBarEditor(): TopBarEditorBinding | null {
  return readHolder()?.value ?? null;
}

/**
 * Read the holder so the editor route can write into it. Throws if the
 * layout did not install one — that would be a programmer error (an
 * editor mounted outside the app shell).
 */
export function getTopBarEditorHolder(): TopBarEditorHolder {
  const holder = readHolder();
  if (!holder) {
    throw new Error(
      'Top Bar editor holder is missing. Did you forget to wrap the route in `+layout.svelte`?',
    );
  }
  return holder;
}
