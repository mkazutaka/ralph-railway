import type { PageServerLoad } from './$types';
import {
  makeListWorkflowsHelpers,
  makeWorkflowFileRepository,
} from '$lib/server/repos';
import { toWorkflowSummaryDto } from '$features/workflow-editor/entities/dto';
import { listWorkflowsWorkflow } from '$features/workflow-editor/workflows/listWorkflowsWorkflow';

export const load: PageServerLoad = async () => {
  // Delegate to `listWorkflowsWorkflow` so the index page and the REST
  // endpoint (`GET /api/workflows`) share a single implementation of the
  // list-workflows scenario (CollectWorkflowFiles → SummarizeEach with
  // filename fallback). The route only owns the wiring and the entity → DTO
  // de-branding.
  const fileRepo = makeWorkflowFileRepository();
  const helpers = makeListWorkflowsHelpers();
  const result = await listWorkflowsWorkflow({
    listWorkflowFiles: fileRepo.listWorkflowFiles,
    ...helpers,
  });
  return { workflows: result.workflows.map(toWorkflowSummaryDto) };
};
