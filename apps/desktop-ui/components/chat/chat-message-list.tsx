"use client";

import { useRef, useEffect } from "react";
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
}

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
}: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasStreamingMessage = Boolean(streamingContent) || activeToolCalls.length > 0;
  const showThinking = isThinking && !hasStreamingMessage;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent, activeToolCalls.length, showThinking]);

  if (messages.length === 0 && !showThinking) return null;

  return (
    <div className={cn("flex-1 overflow-y-auto px-4 py-6", className)}>
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
        {showThinking && <ChatThinkingIndicator />}
        {hasStreamingMessage && (
          <ChatMessage
            message={{ role: "assistant", content: streamingContent || "", toolCalls: activeToolCalls, createdAt: new Date().toISOString() }}
            isStreaming
          />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
