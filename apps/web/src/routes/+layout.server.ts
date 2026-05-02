import type { LayoutServerLoad } from './$types';
import {
  makeListWorkflowsHelpers,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import { toWorkflowSummaryDto } from '$features/workflow-editor/entities/dto';
import { listWorkflowsWorkflow } from '$features/workflow-editor/workflows/listWorkflowsWorkflow';

/**
 * Layout-level load supplying the data the persistent app shell
 * (`apps/web/src/routes/+layout.svelte`) needs on every page:
 *
 *   - `workflows` populates the Left Sidebar file tree (`iHBGe` in
 *     `apps/web/design/app.pen`). The shell is the canonical surface
 *     for switching between workflows now that the index page no longer
 *     owns its own list, so the shell — not the editor route — has to
 *     own this data.
 *
 * The layout intentionally does NOT load the *current* workflow's YAML
 * here (that stays on the editor route's own `+page.server.ts`). The
 * workflow document changes far more often than the file list, and we
 * do not want to invalidate the layout payload — and re-render the
 * sidebar — every time the user types in the editor. Reusing the same
 * `listWorkflowsWorkflow` the index page used keeps the sidebar's data
 * shape identical to the existing scenario contract (`WorkflowSummary`
 * → `WorkflowSummaryDto`).
 */
export const load: LayoutServerLoad = async () => {
  const fileRepo = makeWorkflowFileRepository();
  const helpers = makeListWorkflowsHelpers();
  const result = await listWorkflowsWorkflow({
    listWorkflowFiles: fileRepo.listWorkflowFiles,
    ...helpers,
  });
  return { workflows: result.workflows.map(toWorkflowSummaryDto) };
};
