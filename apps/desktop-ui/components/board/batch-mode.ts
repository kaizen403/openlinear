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
