import type { PageServerLoad } from './$types';
import { createWorkflowStore, getWorkflowsDir } from '$lib/server/workflows';

export const load: PageServerLoad = async () => {
  const store = createWorkflowStore(getWorkflowsDir());
  return { workflows: await store.list() };
};
