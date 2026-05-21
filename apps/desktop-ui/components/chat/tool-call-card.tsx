"use client";

import { useState } from "react";
import { ChevronRight, Check, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StreamingToolCall } from "@/hooks/use-chat-stream";

interface ToolCallCardProps {
  toolCall: StreamingToolCall;
}

const STATUS_ICON = {
  pending: <Loader2 className="h-3 w-3 animate-spin text-linear-text-tertiary" />,
  in_progress: <Loader2 className="h-3 w-3 animate-spin text-primary" />,
  completed: <Check className="h-3 w-3 text-green-400" />,
  error: <AlertCircle className="h-3 w-3 text-destructive" />,
} as const;

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-linear-text-secondary hover:bg-linear-bg-secondary transition-colors"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
        />
        {STATUS_ICON[toolCall.status]}
        <span className="font-medium">{formatToolName(toolCall.name)}</span>
      </button>
      {expanded && (
        <div className="border-t border-linear-border px-3 py-2 space-y-2">
          {toolCall.arguments && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-linear-text-tertiary">Input</span>
              <pre className="mt-0.5 text-xs text-linear-text-secondary font-mono whitespace-pre-wrap break-all">
                {toolCall.arguments}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-linear-text-tertiary">Result</span>
              <pre className={cn(
                "mt-0.5 text-xs font-mono whitespace-pre-wrap break-all",
                toolCall.isError ? "text-destructive" : "text-linear-text-secondary"
              )}>
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
