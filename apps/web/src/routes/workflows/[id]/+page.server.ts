import { error, fail, type ActionFailure } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  makeInsertPatternHelpers,
  makeOpenWorkflowHelpers,
  makePatternTemplateRepository,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import {
  toInsertPatternFailureContext,
  toInsertedPatternDto,
  toOpenedWorkflowDto,
  toPatternEntryDto,
  type InsertedPatternDto,
} from '$features/workflow-editor/entities/dto';
import { insertPatternWorkflow } from '$features/workflow-editor/workflows/insertPatternWorkflow';
import { openWorkflowWorkflow } from '$features/workflow-editor/workflows/openWorkflowWorkflow';
import { handleInsertPatternFailure } from '$features/workflow-editor/lib/insertPatternRoute';
import {
  parseWorkflowParam,
  safeParsePatternId,
  safeParseWorkflowParam,
} from '$features/workflow-editor/lib/routeHelpers';

/**
 * Load function for the workflow editor page.
 *
 * Returns the YAML buffer + the pattern catalog the picker needs. We
 * deliberately do NOT include recent runs here even though the project
 * convention is "the page-level load owns all data the page needs"
 * (review note m1 on the recent-runs scenario). Reasoning:
 *
 *   - Run state changes asynchronously (pending → running → succeeded)
 *     several times per minute. Folding run rows into the page load would
 *     either require polling-via-`invalidate` (thrashes the YAML re-read)
 *     or stale data on the panel.
 *   - Re-running this load on every run-list refresh would re-emit
 *     `data.yaml`, which `+page.svelte` mirrors into the editor buffer via
 *     `editor.syncFromServer`. That would clobber any unsaved edits the
 *     user is mid-typing.
 *
 * The runs panel (`RecentRuns.svelte`) therefore owns its own fetch
 * against `GET /api/workflows/:id/runs`. The endpoint returns the same
 * branded entities through the DTO boundary as everything else, so the
 * separation is purely about *who* triggers the fetch — not about
 * cross-cutting type/contract risk.
 */
export const load: PageServerLoad = async ({ params }) => {
  const workflowId = parseWorkflowParam(params.id);
  const fileRepo = makeWorkflowFileRepository();
  const patternRepo = makePatternTemplateRepository();
  const helpers = makeOpenWorkflowHelpers();

  // Run the open-workflow scenario
  // (`docs/scenarios/workflow-management/open-workflow.md`). The workflow
  // owns the `LocateWorkflow` / `RenderGraph` substeps so the load function
  // stays a thin entry point: it parses the route param, invokes the
  // workflow, and maps the discriminated output to a SvelteKit `error()` /
  // DTO response. The graph is now produced server-side and shipped to the
  // client via `OpenedWorkflowDto`; the editor still re-parses the buffer
  // client-side (`yamlToFlow`) for live feedback as the user types, but the
  // initial page hydration is driven by the same DMMF entity the rest of
  // the feature consumes.
  const result = await openWorkflowWorkflow(
    { workflowId },
    {
      readWorkflowFile: fileRepo.readWorkflowFile,
      ...helpers,
    },
  );
  if (result.kind === 'notFound') throw error(404, 'workflow not found');

  // De-brand at the entity → DTO boundary (review note m-1): branded
  // primitives are strings at runtime, so the conversion is a free cast, but
  // we keep it inside `entities/dto.ts` so the page does not need to import
  // `WorkflowId` / `YamlSource` and the de-branding policy stays in one
  // place.
  const openedDto = toOpenedWorkflowDto(result.opened);
  return {
    // Preserve the existing flat shape (`{ id, yaml }`) consumed by the
    // page component while exposing the richer `opened` envelope for code
    // that wants the server-rendered graph + display name. Keeping both
    // surfaces alive in the same payload avoids a client-side refactor in
    // this scenario; subsequent UI work can migrate to `data.opened.graph`
    // and drop the legacy fields.
    id: openedDto.id,
    yaml: openedDto.yaml,
    opened: openedDto,
    patterns: patternRepo.listPatternTemplates().map(toPatternEntryDto),
  };
};

/**
 * Discriminated union pinning the success shape returned by the form action.
 * Failure paths use `fail(status, { ok: false, message })` and return the
 * `ActionFailure<{ ok: false; message: string }>` envelope SvelteKit expects.
 *
 * Review note (error-handling Minor 1): typing this explicitly means the
 * Svelte page binding can branch on `form.ok` with full type narrowing
 * (`form.inserted` becomes available only on success) instead of relying on
 * the inferred shape, which previously surfaced as `any` once SvelteKit's
 * `Awaited<ReturnType<...>>` widened across both branches.
 */
export type InsertPatternActionResult =
  | { ok: true; inserted: InsertedPatternDto }
  | ActionFailure<{ ok: false; message: string }>;

export const actions: Actions = {
  /**
   * Form-action equivalent of POST /api/workflows/:id/patterns. Using a form
   * action lets SvelteKit handle CSRF protection automatically and keeps
   * mutations tied to a load-function re-run via `invalidateAll()`.
   *
   * Failure handling (logging + status mapping) is delegated to
   * `handleInsertPatternFailure` so the REST endpoint and this action stay
   * in lockstep automatically.
   *
   * The return type is the explicit `InsertPatternActionResult` discriminated
   * union (review note error-handling Minor 1) so the form binding on the
   * Svelte side can branch on `ok` without inferred-type guesswork.
   */
  insertPattern: async ({ params, request }): Promise<InsertPatternActionResult> => {
    // Form actions: prefer `fail(400, ...)` to `error(400, ...)` so the user
    // sees the page-level toast instead of a full-page 400. The `safe*`
    // helpers return a discriminated result instead of throwing.
    const wf = safeParseWorkflowParam(params.id);
    if (!wf.ok) return fail(400, { ok: false, message: wf.reason });
    const workflowId = wf.value;

    const data = await request.formData();
    const rawPatternId = data.get('patternId');
    if (typeof rawPatternId !== 'string') {
      return fail(400, { ok: false, message: 'patternId is required' });
    }
    const pid = safeParsePatternId(rawPatternId);
    if (!pid.ok) return fail(400, { ok: false, message: pid.reason });
    const patternId = pid.value;

    const fileRepo = makeWorkflowFileRepository();
    const patternRepo = makePatternTemplateRepository();
    const helpers = makeInsertPatternHelpers();
    const result = await insertPatternWorkflow(
      { workflowId, patternId },
      {
        readWorkflowFile: fileRepo.readWorkflowFile,
        writeWorkflowFile: fileRepo.writeWorkflowFile,
        loadPatternTemplate: patternRepo.loadPatternTemplate,
        ...helpers,
      },
    );

    if (result.kind === 'patternInserted') {
      // The `inserted` DTO carries `workflowId`, `patternId`, and `yaml`.
      // The form-action client (`features/workflow-editor/lib/api.ts`) only
      // reads `patternId` and `yaml`, but we intentionally co-ship the full
      // DTO here so this surface and the REST endpoint
      // (`/api/workflows/:id/patterns`) stay in lockstep on the wire shape.
      return { ok: true, inserted: toInsertedPatternDto(result.result) };
    }

    // De-brand once via the DTO helper (review note Minor 2) instead of
    // sprinkling `as string` casts inline. The failure context contract lives
    // in `entities/dto.ts` next to the other entity → string converters.
    const failure = handleInsertPatternFailure(
      result,
      toInsertPatternFailureContext(workflowId, patternId),
    );
    return fail(failure.status, { ok: false, message: failure.message });
  },
};
