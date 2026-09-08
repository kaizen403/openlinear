import type { BatchTask } from './types';

export interface TaskPromptRecord {
  title?: string | null;
  description?: string | null;
}

export interface ModelOverride {
  providerID: string;
  modelID: string;
}

/**
 * T9 (H-04/H-05/M-01) — pure `provider/model` string parsing shared by the
 * single-task path (lifecycle.ts) and the batch path (batch/orchestrator.ts)
 * so both resolve a per-task model override the same way. Batch execution
 * previously ignored `Task.model` entirely; this is the shared piece that
 * lets both callers pass a real `model` field into `session.prompt`/
 * `session.promptAsync` instead of silently falling back to whatever
 * OpenCode's global default happens to be.
 */
export function parseModelOverride(modelStr: string | null | undefined): ModelOverride | undefined {
  if (!modelStr) return undefined;
  const slashIdx = modelStr.indexOf('/');
  if (slashIdx <= 0 || slashIdx === modelStr.length - 1) return undefined;
  return {
    providerID: modelStr.slice(0, slashIdx),
    modelID: modelStr.slice(slashIdx + 1),
  };
}

export interface CombinedPromptRecord extends TaskPromptRecord {
  id: string;
  identifier?: string | null;
}

export function buildSingleTaskPrompt(taskRecord: TaskPromptRecord | null | undefined, fallbackTitle: string): string {
  let prompt = taskRecord?.title || fallbackTitle;
  if (taskRecord?.description) {
    prompt += `\n\n${taskRecord.description}`;
  }

  prompt += [
    '',
    '',
    'Execution contract:',
    '- Make the requested code changes directly in this worktree before finishing.',
    '- If you use a background subtask, wait for its result and apply any required changes before completing.',
    '- Do not mark the task complete unless the worktree contains the requested changes or you can explain why no code change is valid.',
  ].join('\n');

  return prompt;
}

export function buildCombinedBatchPrompt(tasks: BatchTask[], taskRecords: CombinedPromptRecord[]): string {
  const recordMap = new Map(taskRecords.map(task => [task.id, task]));

  const taskSections = tasks.map((task, index) => {
    const record = recordMap.get(task.taskId);
    const title = record?.title || task.title;
    const label = record?.identifier ? `${record.identifier}: ${title}` : title;
    const description = record?.description?.trim() || 'No additional description provided.';

    return [
      `Task ${index + 1}: ${label}`,
      `Task ID: ${task.taskId}`,
      '',
      description,
    ].join('\n');
  });

  return [
    `Execute these ${tasks.length} selected tasks together in one coherent implementation.`,
    '',
    'Selected tasks:',
    '',
    taskSections.join('\n\n---\n\n'),
    '',
    'Execution contract:',
    '- Make the requested code changes directly in this worktree before finishing.',
    '- Satisfy every listed task in this single session; do not treat this as one task only.',
    '- Resolve overlap between tasks as one coherent change set.',
    '- If you use a background subtask, wait for its result and apply any required changes before completing.',
    '- Before finishing, summarize task-by-task coverage so each selected task has an explicit result.',
    '- Do not mark the work complete unless the worktree contains the requested changes or you can explain why no code change is valid for all listed tasks.',
  ].join('\n');
}
