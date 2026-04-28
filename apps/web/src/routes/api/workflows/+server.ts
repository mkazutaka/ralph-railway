import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createWorkflowStore, getWorkflowsDir } from '$lib/server/workflows';

const store = createWorkflowStore(getWorkflowsDir());

export const GET: RequestHandler = async () => {
  const list = await store.list();
  return json(list);
};

export const POST: RequestHandler = async ({ request }) => {
  let body: { id?: unknown; yaml?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; yaml?: unknown };
  } catch {
    return json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.id !== 'string' || typeof body.yaml !== 'string') {
    return json({ error: 'id and yaml required as strings' }, { status: 400 });
  }
  try {
    await store.write(body.id, body.yaml);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }
  return json({ id: body.id }, { status: 201 });
};
