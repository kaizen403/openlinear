/** Kept in the runner system prompt so compaction cannot drop it. */
export const EXECUTION_SYSTEM_CONTRACT = [
  'Execution contract:',
  '- Make the requested code changes directly in this repository before finishing.',
  '- If you spawn a child session, wait for its result and apply any required changes before completing.',
  '- Do not mark the task complete unless the repository contains the requested changes or you can explain why no code change is valid.',
  '- Never modify .github/, git hooks, or package.json scripts unless the user explicitly asked and the change is approved.',
].join('\n');
