export type BatchMode = 'parallel' | 'queue' | 'combined'

export function formatBatchMode(mode: string | null | undefined): string {
  switch (mode) {
    case 'parallel':
      return 'Parallel'
    case 'queue':
      return 'Queue'
    case 'combined':
      return 'Combined'
    default:
      return 'Batch'
  }
}

export function formatBatchExecutionMode(mode: string | null | undefined): string {
  switch (mode) {
    case 'parallel':
      return 'Parallel Execution'
    case 'queue':
      return 'Queue Execution'
    case 'combined':
      return 'Combined Execution'
    default:
      return 'Batch Execution'
  }
}

export function getBatchActivityId(batchId: string): string {
  return `batch:${batchId}`
}
