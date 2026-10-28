"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownView } from "@/components/markdown-view";
import { ToolCallCard } from "./tool-call-card";
import { TurnUsageFooter } from "./turn-usage";
import type { ChatTurnControls, StreamingMessage } from "@/hooks/use-chat-stream";

interface ChatMessageProps {
  message: StreamingMessage;
  isStreaming?: boolean;
  /** Confirmation and retry actions; absent on read-only surfaces. */
  controls?: ChatTurnControls;
}

const INCOMPLETE_LABEL = {
  error: "Incomplete: the reply failed before it finished",
  stopped: "Incomplete: you stopped this reply",
  length: "Cut off: the reply hit the model's length limit",
} as const;

export function ChatMessage({ message, isStreaming, controls }: ChatMessageProps) {
  const isUser = message.role === "user";
  const incomplete = message.incomplete;
  const error = incomplete?.reason === "error" ? incomplete.error : undefined;
  const canRetry = Boolean(controls && message.id && message.retry === "available");
  const changesRan = Boolean(incomplete) && message.toolCalls.some(
    (call) => call.effect !== "read" && (call.status === "completed" || call.status === "unknown"),
  );
  const bubbleClassName = cn(
    "max-w-[80%] px-3.5 py-2.5 text-sm leading-relaxed break-words",
    isUser
      ? "rounded-sm bg-linear-bg-tertiary text-linear-text border-l-2 border-linear-accent whitespace-pre-wrap"
      : "rounded-sm bg-linear-bg-secondary text-linear-text",
    incomplete && !isUser && "border border-dashed border-warning/40",
    isStreaming && "animate-pulse motion-reduce:animate-none"
  );

  return (
    <div
      className={cn("group flex flex-col gap-2", isUser && "items-end")}
      data-incomplete={incomplete?.reason}
    >
      {message.toolCalls.length > 0 && (
        <div className="w-full space-y-1.5">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} controls={controls} />
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
          {incomplete && !isUser && (
            <p className="mt-2 border-t border-dashed border-linear-border pt-1.5 text-[11px] text-warning">
              {INCOMPLETE_LABEL[incomplete.reason]}
            </p>
          )}
        </div>
      )}
      {incomplete && !isUser && (incomplete.reason !== "length" || !message.content) && (
        <div
          className={cn(
            "flex max-w-[80%] items-start gap-2 rounded-sm border px-3 py-2 text-xs",
            error ? "border-destructive/40 bg-destructive/5" : "border-linear-border bg-linear-bg-secondary",
          )}
          role={error ? "alert" : undefined}
        >
          <AlertTriangle
            className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", error ? "text-destructive" : "text-warning")}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-linear-text">
              {error
                ? error.message
                : incomplete.reason === "stopped"
                  ? "You stopped this reply before it finished."
                  : INCOMPLETE_LABEL[incomplete.reason]}
            </p>
            {error?.hint && <p className="text-linear-text-secondary">{error.hint}</p>}
            {changesRan && (
              <p className="text-warning">Some actions in this reply already ran. Check them before retrying.</p>
            )}
            {(canRetry || message.retry === "used") && (
              <div className="pt-0.5">
                {canRetry ? (
                  <button
                    type="button"
                    onClick={() => message.id && controls?.retry(message.id)}
                    disabled={controls?.status === "streaming"}
                    className="inline-flex h-6 items-center gap-1 rounded-sm border border-linear-border px-2 text-xs text-linear-text-secondary transition-colors hover:bg-linear-bg-tertiary hover:text-linear-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linear-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Retry
                  </button>
                ) : (
                  <span className="text-[11px] text-linear-text-tertiary">Retried below.</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {!isUser && message.notices?.map((notice, index) => (
        <p
          key={`${notice.code ?? "notice"}-${index}`}
          className="flex max-w-[80%] items-start gap-1.5 rounded-sm border border-warning/40 bg-linear-bg-secondary px-3 py-1.5 text-[11px] text-linear-text-secondary"
          data-budget-notice={notice.code ?? undefined}
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {notice.message}
            {notice.hint ? ` ${notice.hint}` : ""}
          </span>
        </p>
      ))}
      {!isUser && message.usage && <TurnUsageFooter usage={message.usage} className="max-w-[80%]" />}
    </div>
  );
}
