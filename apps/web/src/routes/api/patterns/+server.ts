import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makePatternTemplateRepository } from '$lib/server/repos';
import { toPatternEntryDto } from '$features/workflow-editor/entities/dto';

/**
 * GET /api/patterns
 *
 * Returns the pattern showcase. Includes unsupported patterns so the UI can
 * display them as preview-only entries (invariant 3 in insert-pattern.md).
 *
 * No `Cache-Control` is set: the page-level load function reads the registry
 * directly (not via this endpoint), so a TTL here would only mislead external
 * callers into thinking the page sees a stale list. Add caching back here
 * only when the registry becomes data-driven and the page consumes it through
 * this endpoint.
 */
export const GET: RequestHandler = () => {
  const repo = makePatternTemplateRepository();
  return json(repo.listPatternTemplates().map(toPatternEntryDto));
};
