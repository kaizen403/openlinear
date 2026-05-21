"use client";

import { useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./chat-message";
import type { StreamingMessage } from "@/hooks/use-chat-stream";

interface ChatMessageListProps {
  messages: StreamingMessage[];
  streamingContent?: string;
  activeToolCalls?: StreamingMessage["toolCalls"];
  className?: string;
}

export function ChatMessageList({ messages, streamingContent, activeToolCalls = [], className }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent, activeToolCalls.length]);

  if (messages.length === 0) return null;

  return (
    <div className={cn("flex-1 overflow-y-auto px-4 py-6", className)}>
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
        {(streamingContent || activeToolCalls.length > 0) && (
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
