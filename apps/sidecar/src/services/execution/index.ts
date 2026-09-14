export { executeTask, cancelTask } from './lifecycle';
export { isTaskRunning, getExecutionLogs, getRunningTaskCount, getExecutionStatus, executionStore, ExecutionStateStore } from './state';
export type { ExecutionLogEntry } from './state';
export { gitService, GitService } from './git';
export type { IGitService } from './git';
