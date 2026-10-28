"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ChatStreamError,
  fetchChatSession,
  revokeChatConfirmation,
  sendChatMessage,
  type ChatChunk,
  type ChatMessage,
  type ChatTurnUsage,
} from '@/lib/api/chat';
import type { DescribedApiError } from '@/lib/api/errors';
import { ApiError } from '@/lib/api/fetch';
import {
  applyLegacyToolResult,
  applyOutcomeStates,
  applyReconciliation,
  applyToolResult,
  confirmationFromChunk,
  confirmationMessage,
  deriveHistory,
  describeBudgetWarning,
  describeChatError,
  dismissConfirmationState,
  extractConfirmationCodes,
  findReconciledCall,
  findToolCallIndex,
  finishSubmitted,
  hasRefreshableUnknown,
  interruptToolCall,
  isConfirmationExpired,
  markSubmitted,
  mergeConfirmation,
  normalizeConfirmationCode,
  reconcileMessages,
  registerConfirmation,
  settleRedemption,
  settleRevoke,
  summarizeSessionUsage,
  supersedeSubmitted,
  toolCallFromChunk,
  type ChatConfirmation,
  type ConfirmationStates,
  type HistoryExtras,
  type SessionUsage,
  type StreamingMessage,
  type StreamingToolCall,
  type TurnInterruption,
} from './chat-stream-state';

export type {
  ChatConfirmation,
  ConfirmationPhase,
  ConfirmationPreview,
  ConfirmationState,
  ConfirmationStates,
  PreviewIssue,
  SessionUsage,
  StreamingMessage,
  StreamingToolCall,
  ToolCallStatus,
  TurnInterruption,
} from './chat-stream-state';

export type StreamStatus = 'idle' | 'streaming' | 'error';

/**
 * When a turn ends with writes whose outcome is unknown (stopped or failed
 * mid-write), the hook re-reads the session's journal states at these delays
 * until the server has recorded what really happened.
 */
export const OUTCOME_REFRESH_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

export interface SendOptions {
  /** Confirmation codes approved with an explicit control (sent as `confirmationTokens`). */
  confirmationTokens?: string[];
}

/** What the transcript needs to render confirmation cards and Retry. */
export interface ChatTurnControls {
  status: StreamStatus;
  confirmations: ConfirmationStates;
  /** Confirm one card: sends exactly its code. False when the card can't be confirmed now. */
  confirm: (code: string) => boolean;
  dismissConfirmation: (code: string) => void;
  /** Resend the request that produced an incomplete turn. */
  retry: (messageId: string) => void;
}

interface TurnRequest {
  sessionId: string;
  content: string;
  attachmentIds?: string[];
  confirmationTokens?: string[];
}

interface ActiveTurn {
  id: string;
  /** Codes this turn's user message submitted. */
  codes: Set<string>;
  /** The server stored the user message (`user_message` chunk). */
  acknowledged: boolean;
  request: TurnRequest;
}

let localIdCounter = 0;
function nextLocalId(): string {
  localIdCounter += 1;
  return `turn-${Date.now().toString(36)}-${localIdCounter}`;
}

export function useChatStream() {
  const [messages, setMessages] = useState<StreamingMessage[]>([]);
  const [status, setStatusState] = useState<StreamStatus>('idle');
  const [streamingContent, setStreamingContent] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<StreamingToolCall[]>([]);
  const [confirmations, setConfirmationsState] = useState<ConfirmationStates>({});
  const abortRef = useRef<AbortController | null>(null);
  // Mirror the in-flight accumulation so `stop()` — a separate callback with
  // no access to `send()`'s local closure — can commit whatever streamed in
  // so far instead of discarding it. `toolCallsInFlightRef` is aliased once
  // per `send()` call and then mutated in place, so the ref always points at
  // the live array; `accumulatedContentRef` needs an explicit write on every
  // reassignment since strings aren't references.
  const accumulatedContentRef = useRef('');
  const toolCallsInFlightRef = useRef<StreamingToolCall[]>([]);
  const finalizedRef = useRef(false);
  // Synchronous mirrors: confirm/retry must decide before React re-renders,
  // so a double click can never submit a code twice.
  const statusRef = useRef<StreamStatus>('idle');
  const confirmationsRef = useRef<ConfirmationStates>({});
  const registryRef = useRef(new Map<string, ChatConfirmation>());
  const confirmLocksRef = useRef(new Set<string>());
  const requestsRef = useRef(new Map<string, TurnRequest>());
  const sessionIdRef = useRef<string | null>(null);
  const turnRef = useRef<ActiveTurn | null>(null);
  // Bumped by stop/reset/a new send: callbacks of an abandoned stream are ignored.
  const generationRef = useRef(0);
  // Mirror of `messages` for the outcome refresh (computed outside render).
  const messagesRef = useRef<StreamingMessage[]>([]);
  const outcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => {
    if (outcomeTimerRef.current) clearTimeout(outcomeTimerRef.current);
  }, []);

  const setStatus = useCallback((next: StreamStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const updateConfirmations = useCallback((update: (states: ConfirmationStates) => ConfirmationStates) => {
    const next = update(confirmationsRef.current);
    if (next === confirmationsRef.current) return;
    confirmationsRef.current = next;
    setConfirmationsState(next);
  }, []);

  /** Settle the active turn's submitted codes; reopened codes can be confirmed again. */
  const settleTurnConfirmations = useCallback((turn: ActiveTurn | null, failure?: DescribedApiError) => {
    if (!turn || turn.codes.size === 0) return;
    let reopened: string[] = [];
    updateConfirmations((states) => {
      const result = finishSubmitted(states, turn.codes, turn.acknowledged, failure);
      reopened = result.reopened;
      return result.states;
    });
    for (const code of reopened) confirmLocksRef.current.delete(code);
  }, [updateConfirmations]);

  /** A call that redeemed a code settled late: the card follows the real outcome. */
  const settleLateRedemptions = useCallback((before: readonly StreamingMessage[], after: readonly StreamingMessage[]) => {
    after.forEach((message, messageIndex) => {
      message.toolCalls.forEach((call, callIndex) => {
        const previous = before[messageIndex]?.toolCalls[callIndex];
        if (call.redeems && call.reconciled && previous?.status === 'unknown') {
          const code = call.redeems;
          updateConfirmations(states => settleRedemption(
            states[code]?.phase === 'outcome_unknown' ? { ...states, [code]: { ...states[code], phase: 'submitting' } } : states,
            code,
            call,
          ));
        }
      });
    });
  }, [updateConfirmations]);

  /** Re-read journal states until every refreshable unknown outcome is resolved (or we give up). */
  const scheduleOutcomeRefresh = useCallback((sessionId: string, attempt = 0) => {
    if (outcomeTimerRef.current) clearTimeout(outcomeTimerRef.current);
    outcomeTimerRef.current = null;
    const delay = OUTCOME_REFRESH_DELAYS_MS[attempt];
    if (delay === undefined) return;
    outcomeTimerRef.current = setTimeout(() => {
      outcomeTimerRef.current = null;
      if (sessionIdRef.current !== sessionId || !hasRefreshableUnknown(messagesRef.current)) return;
      fetchChatSession(sessionId)
        .then((history) => {
          if (sessionIdRef.current !== sessionId) return;
          const before = messagesRef.current;
          const after = applyOutcomeStates(before, history.messages);
          setMessages(prev => applyOutcomeStates(prev, history.messages));
          settleLateRedemptions(before, after);
          if (hasRefreshableUnknown(after)) scheduleOutcomeRefresh(sessionId, attempt + 1);
        })
        .catch(() => {
          if (sessionIdRef.current === sessionId) scheduleOutcomeRefresh(sessionId, attempt + 1);
        });
    }, delay);
  }, [settleLateRedemptions]);

  const finalizeAssistantMessage = useCallback((
    turn: ActiveTurn | null,
    content: string,
    toolCalls: StreamingToolCall[],
    nextStatus: StreamStatus,
    extra: { incomplete?: TurnInterruption; usage?: ChatTurnUsage; notices?: DescribedApiError[] } = {},
  ) => {
    finalizedRef.current = true;
    const id = turn ? `${turn.id}:assistant` : nextLocalId();
    const interrupted = extra.incomplete && extra.incomplete.reason !== 'length';
    const canRetry = Boolean(interrupted && turn);
    if (canRetry && turn) requestsRef.current.set(id, turn.request);
    const finalCalls = interrupted ? toolCalls.map(interruptToolCall) : [...toolCalls];
    const assistantMsg: StreamingMessage = {
      id,
      role: 'assistant',
      content,
      toolCalls: finalCalls,
      createdAt: new Date().toISOString(),
      live: true,
      ...(extra.incomplete ? { incomplete: extra.incomplete } : {}),
      ...(canRetry ? { retry: 'available' as const } : {}),
      ...(extra.usage ? { usage: extra.usage } : {}),
      ...(extra.notices?.length ? { notices: extra.notices } : {}),
    };
    setMessages(prev => [...prev, assistantMsg]);
    setStreamingContent('');
    setActiveToolCalls([]);
    setStatus(nextStatus);
    settleTurnConfirmations(turn, extra.incomplete?.error);
    if (turnRef.current === turn) turnRef.current = null;
    // Writes interrupted mid-way: ask the server later what really happened.
    const sessionId = turn?.request.sessionId ?? sessionIdRef.current;
    if (sessionId && hasRefreshableUnknown([assistantMsg])) scheduleOutcomeRefresh(sessionId);
  }, [scheduleOutcomeRefresh, setStatus, settleTurnConfirmations]);

  /** Commit what the active stream produced so far, marked as stopped. */
  const stopActive = useCallback(() => {
    abortRef.current?.abort();
    generationRef.current += 1;
    const turn = turnRef.current;
    if (finalizedRef.current) {
      setStatus('idle');
      return;
    }
    const content = accumulatedContentRef.current;
    const toolCalls = toolCallsInFlightRef.current;
    if (content || toolCalls.length > 0) {
      finalizeAssistantMessage(turn, content, toolCalls, 'idle', { incomplete: { reason: 'stopped' } });
    } else {
      finalizedRef.current = true;
      setStreamingContent('');
      setActiveToolCalls([]);
      setStatus('idle');
      settleTurnConfirmations(turn);
      turnRef.current = null;
    }
  }, [finalizeAssistantMessage, setStatus, settleTurnConfirmations]);

  const isLiveCode = useCallback((code: string) => {
    const confirmation = registryRef.current.get(code);
    return Boolean(confirmation) && !(confirmation && isConfirmationExpired(confirmation));
  }, []);

  const send = useCallback(async (sessionId: string, content: string, attachmentIds?: string[], options: SendOptions = {}) => {
    // One stream at a time: keep (and mark) whatever an older stream produced.
    if (statusRef.current === 'streaming') stopActive();

    sessionIdRef.current = sessionId;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const isCurrent = () => generationRef.current === generation;

    const tokens = (options.confirmationTokens ?? [])
      .map(normalizeConfirmationCode)
      .filter((code): code is string => code !== null);
    const request: TurnRequest = {
      sessionId,
      content,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(tokens.length ? { confirmationTokens: tokens } : {}),
    };
    const turn: ActiveTurn = { id: nextLocalId(), codes: new Set(), acknowledged: false, request };
    turnRef.current = turn;

    // Codes this message submits: the confirmed card's token, and any code
    // the user typed (the typed fallback the server also accepts).
    const typed = extractConfirmationCodes(content).filter(code => !tokens.includes(code));
    updateConfirmations((states) => {
      const byButton = markSubmitted(states, tokens, 'button', isLiveCode);
      const byText = markSubmitted(byButton.states, typed, 'typed', isLiveCode);
      for (const code of [...byButton.submitted, ...byText.submitted]) {
        turn.codes.add(code);
        confirmLocksRef.current.add(code);
      }
      return byText.states;
    });

    const userMsg: StreamingMessage = {
      id: `${turn.id}:user`,
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
    accumulatedContentRef.current = '';
    toolCallsInFlightRef.current = toolCallsInFlight;
    finalizedRef.current = false;
    let failed = false;
    let lengthLimited = false;
    let usage: ChatTurnUsage | undefined;
    const notices: DescribedApiError[] = [];

    const complete = () => {
      if (!isCurrent() || finalizedRef.current || failed) return;
      finalizeAssistantMessage(turn, accumulatedContent, toolCallsInFlight, 'idle', {
        ...(lengthLimited ? { incomplete: { reason: 'length' } } : {}),
        ...(usage ? { usage } : {}),
        notices,
      });
    };

    const fail = (error: Error) => {
      if (!isCurrent() || failed || finalizedRef.current) return;
      failed = true;
      finalizeAssistantMessage(turn, accumulatedContent, toolCallsInFlight, 'error', {
        incomplete: { reason: 'error', error: describeChatError(error) },
        ...(usage ? { usage } : {}),
        notices,
      });
    };

    const publishToolCalls = () => setActiveToolCalls([...toolCallsInFlight]);

    const registerFromCall = (call: StreamingToolCall) => {
      const confirmation = call.confirmation;
      if (!confirmation) return;
      registryRef.current.set(confirmation.code, confirmation);
      updateConfirmations(states => supersedeSubmitted(
        registerConfirmation(states, confirmation.code),
        turn.codes,
        call.name,
        confirmation.code,
        code => registryRef.current.get(code)?.toolName,
      ));
    };

    await sendChatMessage({
      sessionId,
      content,
      attachmentIds,
      ...(tokens.length ? { confirmationTokens: tokens } : {}),
      signal: controller.signal,
      onChunk: (chunk: ChatChunk) => {
        if (!isCurrent()) return;
        switch (chunk.type) {
          case 'user_message':
            turn.acknowledged = true;
            break;
          case 'assistant_delta':
            accumulatedContent += chunk.content || '';
            accumulatedContentRef.current = accumulatedContent;
            setStreamingContent(accumulatedContent);
            break;
          case 'tool_call_start': {
            const tc = toolCallFromChunk(chunk);
            if (tc) {
              toolCallsInFlight.push(tc);
              publishToolCalls();
            }
            break;
          }
          case 'tool_result': {
            const toolCallId = chunk.toolResult?.toolCallId ?? chunk.toolCallId;
            if (!toolCallId) break;
            const idx = findToolCallIndex(toolCallsInFlight, toolCallId);
            const call = toolCallsInFlight[idx];
            if (!call) break;
            let updated: StreamingToolCall;
            if (chunk.toolResult) {
              updated = applyLegacyToolResult(call, chunk.toolResult.content, Boolean(chunk.toolResult.isError));
            } else if (chunk.result) {
              updated = applyToolResult(call, chunk.result);
            } else {
              break;
            }
            toolCallsInFlight[idx] = updated;
            publishToolCalls();
            registerFromCall(updated);
            if (updated.redeems) {
              const code = updated.redeems;
              updateConfirmations(states => settleRedemption(states, code, updated));
            }
            break;
          }
          case 'tool_reconciled': {
            if (!chunk.toolCallId || (chunk.status !== 'succeeded' && chunk.status !== 'failed')) break;
            const idx = findReconciledCall(toolCallsInFlight, chunk.toolCallId, chunk.messageId);
            const call = toolCallsInFlight[idx];
            if (call) {
              const updated = applyReconciliation(call, {
                status: chunk.status,
                result: chunk.result ?? null,
                reconciledAfter: chunk.reconciledAfter ?? null,
                reconciledAt: chunk.reconciledAt ?? null,
                effect: chunk.effect,
              });
              toolCallsInFlight[idx] = updated;
              publishToolCalls();
              if (updated.redeems) {
                const code = updated.redeems;
                updateConfirmations(states => settleRedemption(
                  states[code]?.phase === 'outcome_unknown' ? { ...states, [code]: { ...states[code], phase: 'submitting' } } : states,
                  code,
                  updated,
                ));
              }
            } else {
              // A call from an earlier, already finished turn.
              const before = messagesRef.current;
              const after = reconcileMessages(before, chunk);
              if (after) {
                setMessages(prev => reconcileMessages(prev, chunk) ?? prev);
                settleLateRedemptions(before, after);
              }
            }
            break;
          }
          case 'budget_warning':
            notices.push(describeBudgetWarning(chunk));
            break;
          case 'confirmation_required': {
            const confirmation = confirmationFromChunk(chunk);
            if (!confirmation) break;
            const idx = findToolCallIndex(toolCallsInFlight, confirmation.toolCallId);
            const call = toolCallsInFlight[idx];
            const updated: StreamingToolCall = call
              ? { ...call, status: 'needs_confirmation', effect: call.effect ?? 'destructive', confirmation: mergeConfirmation(call.confirmation, confirmation) }
              : {
                  id: confirmation.toolCallId,
                  name: confirmation.toolName,
                  arguments: '',
                  status: 'needs_confirmation',
                  effect: 'destructive',
                  confirmation,
                };
            if (call) toolCallsInFlight[idx] = updated;
            else toolCallsInFlight.push(updated);
            publishToolCalls();
            registerFromCall(updated);
            break;
          }
          case 'assistant_final':
            if (typeof chunk.message === 'object' && chunk.message?.content) {
              accumulatedContent = chunk.message.content;
            } else if (chunk.content) {
              accumulatedContent = chunk.content;
            }
            accumulatedContentRef.current = accumulatedContent;
            if (chunk.finishReason === 'length') lengthLimited = true;
            break;
          case 'done':
            if (chunk.usage) usage = chunk.usage;
            complete();
            break;
          case 'error': {
            const flatMessage = typeof chunk.message === 'string' ? chunk.message : undefined;
            fail(new ChatStreamError(chunk.error?.message || flatMessage || 'Stream error', {
              code: chunk.error?.code ?? chunk.code,
              details: chunk.details,
            }));
            break;
          }
        }
      },
      onError: (error) => {
        if (!controller.signal.aborted) fail(error);
      },
      onDone: () => {
        if (!controller.signal.aborted) complete();
      },
    });
  }, [finalizeAssistantMessage, isLiveCode, setStatus, settleLateRedemptions, stopActive, updateConfirmations]);

  const stop = useCallback(() => {
    stopActive();
  }, [stopActive]);

  const confirm = useCallback((rawCode: string): boolean => {
    const code = normalizeConfirmationCode(rawCode);
    const sessionId = sessionIdRef.current;
    if (!code || !sessionId) return false;
    if (statusRef.current === 'streaming' || confirmLocksRef.current.has(code)) return false;
    const confirmation = registryRef.current.get(code);
    if (!confirmation || confirmationsRef.current[code]?.phase !== 'pending') return false;
    if (isConfirmationExpired(confirmation)) return false;
    confirmLocksRef.current.add(code);
    void send(sessionId, confirmationMessage(confirmation), undefined, { confirmationTokens: [code] });
    return true;
  }, [send]);

  /**
   * Dismiss a card and revoke its code on the server, so it can never run
   * later (from this window, another one, or a typed reply). The card closes
   * at once; the server's answer only refines it (already ran → confirmed,
   * failure → the code still works until it expires).
   */
  const dismissConfirmation = useCallback((rawCode: string) => {
    const code = normalizeConfirmationCode(rawCode);
    if (!code || confirmationsRef.current[code]?.phase !== 'pending') return;
    confirmLocksRef.current.add(code);
    updateConfirmations(states => dismissConfirmationState(states, code));
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      updateConfirmations(states => settleRevoke(states, code, {
        kind: 'failed',
        error: { code: null, status: null, message: 'This chat is not saved yet, so the code could not be cancelled.', retryable: false },
      }));
      return;
    }
    revokeChatConfirmation(sessionId, code)
      .then(() => {
        updateConfirmations(states => settleRevoke(states, code, { kind: 'revoked' }));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'CONFIRMATION_USED') {
          updateConfirmations(states => settleRevoke(states, code, { kind: 'already_ran' }));
          return;
        }
        updateConfirmations(states => settleRevoke(states, code, { kind: 'failed', error: describeChatError(error) }));
      });
  }, [updateConfirmations]);

  const retry = useCallback((messageId: string) => {
    if (statusRef.current === 'streaming') return;
    const request = requestsRef.current.get(messageId);
    if (!request) return;
    requestsRef.current.delete(messageId);
    setMessages(prev => prev.map(message => (message.id === messageId ? { ...message, retry: 'used' } : message)));
    void send(
      request.sessionId,
      request.content,
      request.attachmentIds,
      request.confirmationTokens ? { confirmationTokens: request.confirmationTokens } : {},
    );
  }, [send]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    if (outcomeTimerRef.current) clearTimeout(outcomeTimerRef.current);
    outcomeTimerRef.current = null;
    setMessages([]);
    setStreamingContent('');
    setActiveToolCalls([]);
    setStatus('idle');
    finalizedRef.current = true;
    turnRef.current = null;
    sessionIdRef.current = null;
    registryRef.current = new Map();
    confirmLocksRef.current = new Set();
    requestsRef.current = new Map();
    confirmationsRef.current = {};
    setConfirmationsState({});
  }, [setStatus]);

  /**
   * Replace the transcript with stored history. `extras` (from the same
   * `GET /api/chat/sessions/:id` response) adds server-side confirmation
   * states, so a code dismissed earlier (here or elsewhere) stays dismissed.
   */
  const loadHistory = useCallback((history: ChatMessage[], sessionId?: string, extras: HistoryExtras = {}) => {
    const derived = deriveHistory(history, extras);
    sessionIdRef.current = sessionId ?? history[0]?.sessionId ?? sessionIdRef.current;
    registryRef.current = new Map(derived.confirmations.map(confirmation => [confirmation.code, confirmation]));
    confirmLocksRef.current = new Set(
      Object.entries(derived.states)
        .filter(([, state]) => state.phase !== 'pending')
        .map(([code]) => code),
    );
    requestsRef.current = new Map();
    confirmationsRef.current = derived.states;
    setConfirmationsState(derived.states);
    setMessages(derived.messages);
    messagesRef.current = derived.messages;
    // A write still settling on the server (reloaded right after a stop).
    if (sessionIdRef.current && hasRefreshableUnknown(derived.messages)) scheduleOutcomeRefresh(sessionIdRef.current);
  }, [scheduleOutcomeRefresh]);

  const controls = useMemo<ChatTurnControls>(() => ({
    status,
    confirmations,
    confirm,
    dismissConfirmation,
    retry,
  }), [status, confirmations, confirm, dismissConfirmation, retry]);

  const sessionUsage = useMemo<SessionUsage | null>(() => summarizeSessionUsage(messages), [messages]);

  return {
    messages,
    status,
    streamingContent,
    activeToolCalls,
    confirmations,
    sessionUsage,
    controls,
    send,
    stop,
    reset,
    loadHistory,
    confirm,
    dismissConfirmation,
    retry,
  };
}
