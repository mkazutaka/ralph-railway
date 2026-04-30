import type { PatternId, WorkflowId, YamlSource } from './types';

export interface InsertedPattern {
  readonly workflowId: WorkflowId;
  readonly patternId: PatternId;
  readonly updatedYaml: YamlSource;
}
