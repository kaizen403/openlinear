"use client";

import { cn } from "@/lib/utils";
import { MarkdownView } from "@/components/markdown-view";
import { ToolCallCard } from "./tool-call-card";
import type { StreamingMessage } from "@/hooks/use-chat-stream";

interface ChatMessageProps {
  message: StreamingMessage;
  isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";
  const bubbleClassName = cn(
    "max-w-[80%] px-3.5 py-2.5 text-sm leading-relaxed break-words",
    isUser
      ? "rounded-sm bg-linear-bg-tertiary text-linear-text border-l-2 border-linear-accent whitespace-pre-wrap"
      : "rounded-sm bg-linear-bg-secondary text-linear-text",
    isStreaming && "animate-pulse"
  );

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
        <div className={bubbleClassName}>
          {isUser ? (
            message.content
          ) : (
            <MarkdownView
              body={message.content}
              className="text-linear-text [&_p]:text-linear-text [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_strong]:text-linear-text [&_em]:text-linear-text-secondary [&_ul]:mb-2 [&_ol]:mb-2 [&_pre]:bg-linear-bg-tertiary [&_code]:bg-linear-bg-tertiary"
            />
          )}
        </div>
      )}
    </div>
  );
}
