// Reactive state container for the workflow editor page.
//
// Pulls the YAML buffer, the transient feedback message, and the save /
// insert side-effects out of `+page.svelte` so the page component is a
// thin layout shell. Implemented as a `.svelte.ts` module so it can use
// `$state` / `$derived` / `$effect` runes outside of a component file.
//
// Lifecycle:
//   const editor = createEditorState({ initialYaml, workflowId });
//   $effect(() => editor.syncFromServer({ id: data.id, yaml: data.yaml }));
//   onDestroy(() => editor.dispose());
//
// `syncFromServer` re-runs whenever the SvelteKit load function returns a
// fresh payload (after `invalidateAll()` or a route param change) so the
// textarea stays in sync with disk and the captured `workflowId` is updated
// atomically with the buffer. `dispose` clears any pending feedback timer
// so a stale `setTimeout` cannot fire on a discarded state object.

import { saveWorkflow as saveWorkflowApi, MAX_YAML_BYTES } from './api';
import { editorCopy } from './editorCopy';

const FEEDBACK_TIMEOUT_MS = 3000;

export interface CreateEditorStateInput {
  readonly initialYaml: string;
  readonly workflowId: string;
}

export type FeedbackTone = 'info' | 'error';

export interface EditorState {
  /** Current YAML buffer; read-write via `bind:value`. */
  yaml: string;
  /** True while a save request is in-flight. */
  readonly saving: boolean;
  /** Transient toast-like message; auto-clears after FEEDBACK_TIMEOUT_MS. */
  readonly message: string | null;
  /**
   * Tone of the current message — `'info'` for success / neutral toasts and
   * `'error'` for failures. The page uses this to pick between
   * `role="status" aria-live="polite"` and `role="alert" aria-live="assertive"`
   * (review note M-3).
   */
  readonly messageTone: FeedbackTone;
  /** Persist the buffer to disk. */
  save(): Promise<void>;
  /**
   * Surface a successful pattern insertion result. Called from the picker's
   * `use:enhance` callback after SvelteKit invalidates the load function,
   * so the YAML buffer has already been refreshed via `syncFromServer`. We
   * snapshot the new YAML into `flash()` so the toast still clears as soon
   * as the user starts editing again (review note M-2).
   */
  notifyInserted(patternId: string, yaml: string): void;
  /**
   * Apply a fresh server payload (e.g. after `invalidateAll`). The
   * `{ id, yaml }` shape is required so the captured workflow id is
   * updated atomically with the buffer — otherwise `save()` would PUT to
   * a stale id after navigating between two `/workflows/[id]` routes.
   */
  syncFromServer(payload: { id: string; yaml: string }): void;
  /**
   * Release any pending feedback timer. Must be called when the host
   * component unmounts so a stale `setTimeout` cannot fire on a discarded
   * state object after navigation.
   */
  dispose(): void;
}

/**
 * Build the editor state. Must be called inside a Svelte component / .svelte.ts
 * module reactive context (i.e. somewhere `$state` is legal).
 */
export function createEditorState(input: CreateEditorStateInput): EditorState {
  let yaml = $state(input.initialYaml);
  let saving = $state(false);
  let message = $state<string | null>(null);
  let messageTone = $state<FeedbackTone>('info');
  let lastServerYaml = $state(input.initialYaml);
  // Snapshot of `yaml` taken when feedback was last shown. Held as a plain
  // `let` (not `$state`) because the $effect below only needs to compare
  // against the current `yaml` — we deliberately do not want a reactive
  // re-run when this value changes.
  let yamlAtFeedback: string | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  // Mutable mirror of the workflow id so `save()` always targets the
  // currently visible workflow even if the page param changes mid-session.
  // Updated by `syncFromServer({ id, yaml })`.
  let currentWorkflowId = input.workflowId;

  /**
   * Show a transient feedback message and atomically capture the YAML buffer
   * snapshot the message corresponds to. Both writes happen synchronously in
   * the same microtask so the `$effect` below can never observe `message`
   * with a stale `yamlAtFeedback === null`. This is the invariant that the
   * previous two-call form (`flash(text); yamlAtFeedback = yaml;`) was
   * fragile against — any `await` inserted between those two statements
   * (notably `await invalidateAll()` in `insert()`) would leave a window in
   * which a fresh keystroke could land before the snapshot is taken. By
   * folding both writes into one helper, callers cannot accidentally split
   * them.
   */
  function flash(text: string, snapshot: string, tone: FeedbackTone = 'info') {
    yamlAtFeedback = snapshot;
    message = text;
    messageTone = tone;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      message = null;
      // Restore the default tone alongside clearing the message so the
      // state object is internally consistent (no stale `'error'` tone
      // sitting next to a null message). Review note m6.
      messageTone = 'info';
      yamlAtFeedback = null;
      feedbackTimer = null;
    }, FEEDBACK_TIMEOUT_MS);
  }

  // Clear stale feedback when the user starts editing again so "Saved" /
  // "Inserted do" don't linger on top of fresh keystrokes. The effect tracks
  // only `yaml` and `message`; `yamlAtFeedback` is read non-reactively (it
  // is a plain `let`, not `$state`) so the comparison is driven only by
  // user-initiated buffer changes.
  //
  // The previous design exposed a two-call form (`flash(text)` followed by
  // `yamlAtFeedback = yaml`) which was fragile against any `await` inserted
  // between the calls — `insert()` in particular needs to await
  // `invalidateAll()` before it can take a stable snapshot. The current
  // `flash(text, snapshot)` API folds both writes into one synchronous step
  // so callers cannot split them by accident.
  $effect(() => {
    // Touch the reactive deps explicitly.
    const currentYaml = yaml;
    const currentMessage = message;
    if (currentMessage && yamlAtFeedback !== null && currentYaml !== yamlAtFeedback) {
      message = null;
      // Mirror the timeout branch: snap the tone back to neutral so a
      // subsequent `flash` always starts from a known baseline (review
      // note m6).
      messageTone = 'info';
      yamlAtFeedback = null;
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
    }
  });

  return {
    get yaml() {
      return yaml;
    },
    set yaml(next: string) {
      yaml = next;
    },
    get saving() {
      return saving;
    },
    get message() {
      return message;
    },
    get messageTone() {
      return messageTone;
    },
    syncFromServer(payload: { id: string; yaml: string }) {
      // INVARIANT: this method MUST stay synchronous (review note M-4).
      // It is called from `+page.svelte`'s `$effect` whenever the load
      // function re-runs, and `save()` reads `currentWorkflowId` /
      // `lastServerYaml` immediately after. Introducing an `await` would
      // open a window in which `save()` could PUT to a stale id after
      // route param change, violating the "save targets the visible
      // workflow" guarantee. If this function ever needs async work
      // (e.g. parsing YAML server-side), pull the workflowId update
      // out and apply it synchronously before any await.
      //
      // Update the captured `workflowId` atomically with the buffer so
      // `save()` cannot PUT to a stale id after navigating between two
      // `/workflows/[id]` routes that share this component instance.
      if (payload.id !== currentWorkflowId) {
        currentWorkflowId = payload.id;
        // Force a buffer reset on workflow switch even if the YAML
        // happens to compare equal across files.
        lastServerYaml = payload.yaml;
        yaml = payload.yaml;
        return;
      }
      if (payload.yaml !== lastServerYaml) {
        lastServerYaml = payload.yaml;
        yaml = payload.yaml;
      }
    },
    async save() {
      // Short-circuit oversize buffers so the user sees a clear message
      // instead of a generic 413 from the server. The byte budget mirrors
      // `MAX_YAML_BYTES` exported from `api.ts` (256 KiB).
      const byteSize = new TextEncoder().encode(yaml).byteLength;
      if (byteSize > MAX_YAML_BYTES) {
        flash(editorCopy.errorPrefix + editorCopy.tooLarge, yaml, 'error');
        return;
      }
      saving = true;
      const result = await saveWorkflowApi(currentWorkflowId, yaml);
      saving = false;
      if (result.ok) {
        flash(editorCopy.saved, yaml, 'info');
      } else if (result.kind === 'failed') {
        flash(editorCopy.errorPrefix + result.message, yaml, 'error');
      }
      // 'cancelled' → silent no-op.
    },
    notifyInserted(patternId, nextYaml) {
      // Called from `<form use:enhance>` after SvelteKit invalidates the
      // load. The `nextYaml` echo is the server-canonical buffer that
      // `syncFromServer` has just written into `yaml`; snapshotting it into
      // `flash` keeps the user-types-after-insert behaviour from M-2.
      //
      // The toast text is built via `editorCopy.insertedTemplate(...)`
      // rather than concatenating a prefix string with the patternId so
      // a future i18n migration can swap the order/grammar without
      // touching call-sites (review note M-2 follow-up).
      flash(editorCopy.insertedTemplate(patternId), nextYaml, 'info');
    },
    // Insert-failure surfacing is intentionally NOT exposed here: the
    // PatternPicker popover already renders failures inline via its own
    // `role="alert"` region (see `PatternPicker.svelte`'s `errorMessage`),
    // and echoing the same failure into the editor toast bar would fire
    // two simultaneous `role="alert"` regions — that breaks Playwright's
    // strict locator rules and produces stuttered screen-reader output.
    // If a future change needs an editor-level toast for insert failures,
    // re-introduce a `notify*` helper here AND remove the picker's inline
    // alert, never both at once.
    dispose() {
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
    },
  };
}
