/**
 * Buffers streaming text/reasoning deltas and emits complete log entries
 * instead of fragment-by-fragment updates.
 *
 * The OpenCode SDK streams LLM output as small token-level deltas. Without
 * buffering, each delta becomes its own activity log entry — producing
 * fragmented, unreadable lines like "Thinking: This is a triv" or partial
 * words. This module accumulates deltas per task and flushes them as whole
 * sentences after a debounce interval, or immediately when a non-text event
 * occurs (tool call, session state change, completion).
 */

const FLUSH_DELAY_MS = 800;

type EmitFn = (message: string) => void;

interface BufferState {
  text: string;
  reasoning: string;
  textTimer: ReturnType<typeof setTimeout> | null;
  reasoningTimer: ReturnType<typeof setTimeout> | null;
  emit: EmitFn;
}

const buffers = new Map<string, BufferState>();

export function getOrCreateBuffer(taskId: string, emit: EmitFn): void {
  if (!buffers.has(taskId)) {
    buffers.set(taskId, {
      text: '',
      reasoning: '',
      textTimer: null,
      reasoningTimer: null,
      emit,
    });
  }
}

function getBuffer(taskId: string): BufferState | undefined {
  return buffers.get(taskId);
}

export function appendTextDelta(taskId: string, delta: string): void {
  const buf = getBuffer(taskId);
  if (!buf) return;

  buf.text += delta;

  if (buf.textTimer) clearTimeout(buf.textTimer);
  buf.textTimer = setTimeout(() => flushText(taskId), FLUSH_DELAY_MS);
}

function flushText(taskId: string): void {
  const buf = getBuffer(taskId);
  if (!buf) return;

  const trimmed = buf.text.trim();
  buf.text = '';

  if (buf.textTimer) {
    clearTimeout(buf.textTimer);
    buf.textTimer = null;
  }

  if (trimmed.length > 0 && trimmed.length < 500) {
    buf.emit(trimmed);
  }
}

export function appendReasoningDelta(taskId: string, delta: string): void {
  const buf = getBuffer(taskId);
  if (!buf) return;

  buf.reasoning += delta;

  if (buf.reasoningTimer) clearTimeout(buf.reasoningTimer);
  buf.reasoningTimer = setTimeout(() => flushReasoning(taskId), FLUSH_DELAY_MS);
}

function flushReasoning(taskId: string): void {
  const buf = getBuffer(taskId);
  if (!buf) return;

  const trimmed = buf.reasoning.trim();
  buf.reasoning = '';

  if (buf.reasoningTimer) {
    clearTimeout(buf.reasoningTimer);
    buf.reasoningTimer = null;
  }

  if (trimmed.length > 0) {
    buf.emit(`Thinking: ${trimmed.slice(0, 200)}`);
  }
}

export function flushDeltaBuffer(taskId: string): void {
  flushText(taskId);
  flushReasoning(taskId);
}

export function cleanupDeltaBuffer(taskId: string): void {
  const buf = getBuffer(taskId);
  if (!buf) return;

  if (buf.textTimer) clearTimeout(buf.textTimer);
  if (buf.reasoningTimer) clearTimeout(buf.reasoningTimer);
  buffers.delete(taskId);
}
