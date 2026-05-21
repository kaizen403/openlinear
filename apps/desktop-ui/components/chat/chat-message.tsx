"use client";

import { cn } from "@/lib/utils";
import { ToolCallCard } from "./tool-call-card";
import type { StreamingMessage } from "@/hooks/use-chat-stream";

interface ChatMessageProps {
  message: StreamingMessage;
  isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("group flex flex-col gap-2", isUser && "items-end")}>
      {message.toolCalls.length > 0 && (
        <div className="w-full space-y-1.5">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
      {message.content && (
        <div
          className={cn(
            "max-w-[80%] px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
            isUser
              ? "rounded-sm bg-linear-bg-tertiary text-linear-text border-l-2 border-primary"
              : "rounded-sm bg-linear-bg-secondary text-linear-text",
            isStreaming && "animate-pulse"
          )}
        >
          {message.content}
        </div>
      )}
    </div>
  );
}
