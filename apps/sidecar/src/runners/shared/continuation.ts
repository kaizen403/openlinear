/**
 * Sent when a native session is resumed without new input: continue from the
 * saved conversation and the current repository state, never replay the
 * original task.
 */
export const RESUME_CONTINUATION_PROMPT =
  'Continue the interrupted task from the saved conversation and current repository state. Verify completed work before repeating any actions.';
