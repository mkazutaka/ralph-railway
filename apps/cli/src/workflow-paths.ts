import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type WorkflowSource = 'project' | 'user' | 'env';

export interface WorkflowSearchDir {
  dir: string;
  source: WorkflowSource;
}

export interface ResolvedWorkflow {
  path: string;
  source: WorkflowSource;
  dir: string;
}

export interface ListedWorkflow {
  name: string;
  source: WorkflowSource;
  path: string;
}

const RAILWAYS_SUBDIR = '.agents/railways';

/**
 * Ordered list of directories to search for workflow files.
 * Highest priority first: project → user → env-supplied extras.
 */
export function workflowSearchDirs(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): WorkflowSearchDir[] {
  const dirs: WorkflowSearchDir[] = [
    { dir: resolve(cwd, RAILWAYS_SUBDIR), source: 'project' },
    { dir: resolve(home, RAILWAYS_SUBDIR), source: 'user' },
  ];
  const extra = env.RALPH_RAILWAYS_PATH;
  if (extra) {
    for (const raw of extra.split(':')) {
      const trimmed = raw.trim();
      if (trimmed) dirs.push({ dir: resolve(trimmed), source: 'env' });
    }
  }
  return dirs;
}

/**
 * Resolve a workflow by name. Returns the first match in priority order,
 * or `null` if nothing is found. Tries `.yaml` then `.yml`.
 */
export function resolveWorkflow(
  name: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ResolvedWorkflow | null {
  for (const { dir, source } of workflowSearchDirs(cwd, env, home)) {
    for (const ext of ['.yaml', '.yml']) {
      const path = resolve(dir, `${name}${ext}`);
      if (existsSync(path) && statSync(path).isFile()) {
        return { path, source, dir };
      }
    }
  }
  return null;
}

/**
 * List every workflow reachable from any search dir. If the same name
 * exists in multiple sources, the higher-priority one wins.
 */
export function listWorkflows(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ListedWorkflow[] {
  const seen = new Map<string, ListedWorkflow>();
  for (const { dir, source } of workflowSearchDirs(cwd, env, home)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const name = entry.replace(/\.ya?ml$/, '');
      if (seen.has(name)) continue;
      seen.set(name, { name, source, path: resolve(dir, entry) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
