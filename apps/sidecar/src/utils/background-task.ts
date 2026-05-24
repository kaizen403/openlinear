export function extractBackgroundTaskId(output: string): string | null {
  return output.match(/(?:task_id|Background Task ID):\s*([A-Za-z0-9_-]+)/i)?.[1] ?? null;
}

export function isBackgroundTaskLaunch(toolName: string, output: string): boolean {
  if (toolName !== 'task') return false;
  const lower = output.toLowerCase();
  return lower.includes('background task started')
    || lower.includes('background task launched')
    || (lower.includes('state: running') && lower.includes('task_status'));
}

export function isBackgroundTaskCancellation(toolName: string, output: string): boolean {
  const lower = `${toolName}\n${output}`.toLowerCase();
  return toolName === 'background_cancel'
    || lower.includes('task cancelled successfully')
    || lower.includes('task canceled successfully')
    || lower.includes('background task cancelled')
    || lower.includes('background task canceled');
}

export function isBackgroundTaskCompletion(output: string): boolean {
  return /Background task completed:/i.test(output) || /\bTask Completed\b/i.test(output);
}

export function isBackgroundTaskFailure(output: string): boolean {
  return /Background task failed:/i.test(output) || /\bTask Failed\b/i.test(output);
}
