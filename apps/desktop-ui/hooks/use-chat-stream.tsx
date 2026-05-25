"use client";

import { useState, useCallback, useRef } from 'react';
import { sendChatMessage, type ChatChunk, type ChatMessage, type ToolCall } from '@/lib/api/chat';

export type StreamStatus = 'idle' | 'streaming' | 'error';

export interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
}

export interface StreamingMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls: StreamingToolCall[];
  createdAt: string;
}

function stringifyStreamValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolCallFromChunk(chunk: ChatChunk): StreamingToolCall | null {
  if (chunk.toolCall) {
    return {
      id: chunk.toolCall.id,
      name: chunk.toolCall.name,
      arguments: chunk.toolCall.arguments,
      status: 'in_progress',
    };
  }
  if (!chunk.toolCallId || !chunk.toolName) return null;
  return {
    id: chunk.toolCallId,
    name: chunk.toolName,
    arguments: stringifyStreamValue(chunk.args),
    status: 'in_progress',
  };
}

function getToolResultFromChunk(chunk: ChatChunk): {
  toolCallId: string;
  content: string;
  isError: boolean;
} | null {
  if (chunk.toolResult) {
    return {
      toolCallId: chunk.toolResult.toolCallId,
      content: chunk.toolResult.content,
      isError: Boolean(chunk.toolResult.isError),
    };
  }
  if (!chunk.toolCallId || !chunk.result) return null;
  const error = chunk.result.error;
  return {
    toolCallId: chunk.toolCallId,
    content: error?.message || stringifyStreamValue(chunk.result.data ?? chunk.result),
    isError: Boolean(error || chunk.result.ok === false),
  };
}

function getAssistantFinalContent(chunk: ChatChunk, fallback: string): string {
  if (typeof chunk.message === 'object' && chunk.message?.content) {
    return chunk.message.content;
  }
  if (chunk.content) return chunk.content;
  return fallback;
}

function getErrorMessage(error: Error): string {
  const raw = error.message.trim();
  if (!raw || raw === 'Stream error') {
    return "I couldn't get a response from the model. Please try again.";
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return `I couldn't get a response from the model: ${parsed.error.message}`;
    }
  } catch {
    // Keep the readable raw message below.
  }
  return `I couldn't get a response from the model: ${raw}`;
}

function normalizeHistoryToolCall(toolCall: ToolCall, index: number): StreamingToolCall {
  const nestedFunction = toolCall.function;
  return {
    id: toolCall.id || `history_tool_${index}`,
    name: toolCall.name || nestedFunction?.name || 'tool',
    arguments: toolCall.arguments || nestedFunction?.arguments || '',
    status: 'completed',
  };
}

export function useChatStream() {
  const [messages, setMessages] = useState<StreamingMessage[]>([]);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<StreamingToolCall[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (sessionId: string, content: string, attachmentIds?: string[]) => {
    const userMsg: StreamingMessage = {
      role: 'user',
      content,
      toolCalls: [],
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setStatus('streaming');
    setStreamingContent('');
    setActiveToolCalls([]);

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulatedContent = '';
    const toolCallsInFlight: StreamingToolCall[] = [];
    let finalized = false;
    let failed = false;

    const appendAssistantMessage = (content: string, toolCalls: StreamingToolCall[]) => {
      finalized = true;
      const assistantMsg: StreamingMessage = {
        role: 'assistant',
        content,
        toolCalls: [...toolCalls],
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, assistantMsg]);
      setStreamingContent('');
      setActiveToolCalls([]);
      setStatus('idle');
    };

    const appendErrorMessage = (error: Error) => {
      if (failed) return;
      failed = true;
      finalized = true;
      const assistantMsg: StreamingMessage = {
        role: 'assistant',
        content: getErrorMessage(error),
        toolCalls: [...toolCallsInFlight],
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, assistantMsg]);
      setStreamingContent('');
      setActiveToolCalls([]);
      setStatus('error');
    };

    await sendChatMessage({
      sessionId,
      content,
      attachmentIds,
      signal: controller.signal,
      onChunk: (chunk: ChatChunk) => {
        switch (chunk.type) {
          case 'assistant_delta':
            accumulatedContent += chunk.content || '';
            setStreamingContent(accumulatedContent);
            break;
          case 'tool_call_start': {
            const tc = getToolCallFromChunk(chunk);
            if (tc) {
              toolCallsInFlight.push(tc);
              setActiveToolCalls([...toolCallsInFlight]);
            }
            break;
          }
          case 'tool_result': {
            const result = getToolResultFromChunk(chunk);
            if (result) {
              const idx = toolCallsInFlight.findIndex(tc => tc.id === result.toolCallId);
              if (idx !== -1) {
                toolCallsInFlight[idx] = {
                  ...toolCallsInFlight[idx],
                  status: result.isError ? 'error' : 'completed',
                  result: result.content,
                  isError: result.isError,
                };
                setActiveToolCalls([...toolCallsInFlight]);
              }
            }
            break;
          }
          case 'assistant_final':
            accumulatedContent = getAssistantFinalContent(chunk, accumulatedContent);
            break;
          case 'user_message':
            break;
          case 'done': {
            if (!finalized) {
              appendAssistantMessage(accumulatedContent, toolCallsInFlight);
            }
            break;
          }
          case 'error':
            appendErrorMessage(new Error(chunk.error?.message || (typeof chunk.message === 'string' ? chunk.message : undefined) || 'Stream error'));
            break;
        }
      },
      onError: (error) => {
        if (!controller.signal.aborted) appendErrorMessage(error);
      },
      onDone: () => {
        if (!finalized && !failed && !controller.signal.aborted) {
          appendAssistantMessage(accumulatedContent, toolCallsInFlight);
        }
      },
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStatus('idle');
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
    setActiveToolCalls([]);
    setStatus('idle');
    abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback((history: ChatMessage[]) => {
    const mapped: StreamingMessage[] = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
        toolCalls: (m.toolCalls || []).map(normalizeHistoryToolCall),
        createdAt: m.createdAt,
      }));
    setMessages(mapped);
  }, []);

  return {
    messages,
    status,
    streamingContent,
    activeToolCalls,
    send,
    stop,
    reset,
    loadHistory,
  };
}
