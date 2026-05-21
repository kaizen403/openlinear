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

export function useChatStream() {
  const [messages, setMessages] = useState<StreamingMessage[]>([]);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<StreamingToolCall[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (sessionId: string, content: string) => {
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

    await sendChatMessage({
      sessionId,
      content,
      signal: controller.signal,
      onChunk: (chunk: ChatChunk) => {
        switch (chunk.type) {
          case 'assistant_delta':
            accumulatedContent += chunk.content || '';
            setStreamingContent(accumulatedContent);
            break;
          case 'tool_call_start':
            if (chunk.toolCall) {
              const tc: StreamingToolCall = {
                id: chunk.toolCall.id,
                name: chunk.toolCall.name,
                arguments: chunk.toolCall.arguments,
                status: 'in_progress',
              };
              toolCallsInFlight.push(tc);
              setActiveToolCalls([...toolCallsInFlight]);
            }
            break;
          case 'tool_result':
            if (chunk.toolResult) {
              const idx = toolCallsInFlight.findIndex(tc => tc.id === chunk.toolResult!.toolCallId);
              if (idx !== -1) {
                toolCallsInFlight[idx] = {
                  ...toolCallsInFlight[idx],
                  status: chunk.toolResult.isError ? 'error' : 'completed',
                  result: chunk.toolResult.content,
                  isError: chunk.toolResult.isError,
                };
                setActiveToolCalls([...toolCallsInFlight]);
              }
            }
            break;
          case 'assistant_final':
            if (chunk.message) {
              accumulatedContent = chunk.message.content || accumulatedContent;
            }
            break;
          case 'done': {
            const assistantMsg: StreamingMessage = {
              role: 'assistant',
              content: accumulatedContent,
              toolCalls: [...toolCallsInFlight],
              createdAt: new Date().toISOString(),
            };
            setMessages(prev => [...prev, assistantMsg]);
            setStreamingContent('');
            setActiveToolCalls([]);
            setStatus('idle');
            break;
          }
          case 'error':
            setStatus('error');
            break;
        }
      },
      onError: () => {
        setStatus('error');
      },
      onDone: () => {
        if (status === 'streaming') {
          const assistantMsg: StreamingMessage = {
            role: 'assistant',
            content: accumulatedContent,
            toolCalls: [...toolCallsInFlight],
            createdAt: new Date().toISOString(),
          };
          setMessages(prev => [...prev, assistantMsg]);
          setStreamingContent('');
          setActiveToolCalls([]);
          setStatus('idle');
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
        toolCalls: (m.toolCalls || []).map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: 'completed' as const,
        })),
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
