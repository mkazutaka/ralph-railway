import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createWorkflowStore, getWorkflowsDir } from '$lib/server/workflows';

export const load: PageServerLoad = async ({ params }) => {
  const store = createWorkflowStore(getWorkflowsDir());
  try {
    const yaml = await store.read(params.id);
    return { id: params.id, yaml };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw error(404, 'workflow not found');
    throw error(400, (e as Error).message);
  }
};
