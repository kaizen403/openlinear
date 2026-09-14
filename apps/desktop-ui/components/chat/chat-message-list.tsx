"use client";

import { useRef, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./chat-message";
import type { StreamingMessage } from "@/hooks/use-chat-stream";

interface ChatMessageListProps {
  messages: StreamingMessage[];
  streamingContent?: string;
  activeToolCalls?: StreamingMessage["toolCalls"];
  isThinking?: boolean;
  className?: string;
  /**
   * Identifies the current conversation (e.g. the active chat session id).
   * When it changes, the "pinned to bottom" state resets and the view jumps
   * to the bottom immediately — otherwise switching to a fresh conversation
   * while scrolled up in a previous, longer one would silently suppress
   * auto-scroll for the new one too.
   */
  sessionKey?: string | null;
}

// How close to the bottom (in px) counts as "pinned" — the user hasn't
// deliberately scrolled up to read earlier messages.
const PIN_THRESHOLD_PX = 80;

function ChatThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-2 rounded-sm bg-linear-bg-secondary px-3.5 py-2.5 text-sm text-linear-text-secondary">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-linear-accent" />
        <span>Thinking</span>
      </div>
    </div>
  );
}

export function ChatMessageList({
  messages,
  streamingContent,
  activeToolCalls = [],
  isThinking = false,
  className,
  sessionKey,
}: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const hasStreamingMessage = Boolean(streamingContent) || activeToolCalls.length > 0;
  const showThinking = isThinking;

  const isNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  }, []);

  // Track whether the user is pinned to the bottom (vs. deliberately
  // scrolled up to read history) so streamed tokens don't yank them back down.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => {
      isPinnedRef.current = isNearBottom();
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [isNearBottom]);

  // rAF-coalesced scroll-to-bottom: multiple triggers within the same frame
  // (e.g. several streamed tokens) collapse into a single scroll.
  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      if (behavior === "smooth") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // A brand-new message landed (not a streamed token) — smooth-scroll, but
  // only if the user hasn't scrolled up to read something else.
  useEffect(() => {
    if (!isPinnedRef.current) return;
    scrollToBottom("smooth");
  }, [messages.length, scrollToBottom]);

  // Streaming content updates 30-60x/sec while a response comes in — jump
  // instantly (no smooth-scroll animation queue) and only while pinned.
  useEffect(() => {
    if (!isPinnedRef.current) return;
    scrollToBottom("auto");
  }, [streamingContent, activeToolCalls.length, showThinking, scrollToBottom]);

  // Switching conversations: always re-pin and jump to the bottom of the
  // newly-loaded conversation, regardless of where the previous one left off.
  useEffect(() => {
    isPinnedRef.current = true;
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  if (messages.length === 0 && !showThinking) return null;

  return (
    <div
      ref={containerRef}
      className={cn("relative min-h-0 flex-1 overflow-y-auto px-4 py-6", className)}
    >
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
        {hasStreamingMessage && (
          <ChatMessage
            message={{ role: "assistant", content: streamingContent || "", toolCalls: activeToolCalls, createdAt: new Date().toISOString() }}
            isStreaming
          />
        )}
        {showThinking && <ChatThinkingIndicator />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
