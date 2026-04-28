import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createWorkflowStore, getWorkflowsDir } from '$lib/server/workflows';

const store = createWorkflowStore(getWorkflowsDir());

export const GET: RequestHandler = async ({ params }) => {
  try {
    const yaml = await store.read(params.id!);
    return new Response(yaml, { headers: { 'content-type': 'text/yaml' } });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw error(404, 'workflow not found');
    throw error(400, (e as Error).message);
  }
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await request.text();
  try {
    await store.write(params.id!, body);
  } catch (e) {
    throw error(400, (e as Error).message);
  }
  return json({ id: params.id });
};

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    await store.remove(params.id!);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw error(404, 'workflow not found');
    throw error(400, (e as Error).message);
  }
  return new Response(null, { status: 204 });
};
