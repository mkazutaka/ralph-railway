export class RalphError extends Error {}
export class WorkflowValidationError extends RalphError {}
export class WorkflowTimeoutError extends RalphError {}
export class WorkflowIterationLimitError extends RalphError {}
export class UserCancelledError extends RalphError {}
export class TaskNotFoundError extends RalphError {}
