"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, ChevronRight, CircleHelp, ClipboardList, Loader2, ShieldAlert, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatToolEffect } from "@/lib/api/chat";
import type { ChatTurnControls, StreamingToolCall, ToolCallStatus } from "@/hooks/use-chat-stream";
import { ConfirmationCard } from "./confirmation-card";

interface ToolCallCardProps {
  toolCall: StreamingToolCall;
  /** Confirmation state and actions; absent on read-only surfaces. */
  controls?: ChatTurnControls;
}

const STATUS_META: Record<ToolCallStatus, { label: string; className: string }> = {
  pending: { label: "Queued", className: "text-linear-text-tertiary" },
  in_progress: { label: "Running", className: "text-linear-accent" },
  completed: { label: "Done", className: "text-success" },
  error: { label: "Failed", className: "text-destructive" },
  unknown: { label: "Outcome unknown", className: "text-warning" },
  needs_confirmation: { label: "Needs confirmation", className: "text-warning" },
};

const EFFECT_META: Record<ChatToolEffect, { label: string; description: string; className: string }> = {
  read: {
    label: "Read",
    description: "Reads data; changes nothing.",
    className: "border-linear-border text-linear-text-tertiary",
  },
  write: {
    label: "Write",
    description: "Changes data directly.",
    className: "border-info/40 text-info",
  },
  destructive: {
    label: "Destructive",
    description: "Broad or hard-to-reverse change; runs only after you confirm a preview.",
    className: "border-destructive/50 text-danger",
  },
  external: {
    label: "External",
    description: "Acts outside OpenLinear; runs only after you confirm a preview.",
    className: "border-discovery/40 text-discovery",
  },
};

function StatusIcon({ status }: { status: ToolCallStatus }) {
  const className = cn("h-3 w-3 shrink-0", STATUS_META[status].className);
  switch (status) {
    case "pending":
    case "in_progress":
      return <Loader2 className={cn(className, "animate-spin motion-reduce:animate-none")} aria-hidden="true" />;
    case "completed":
      return <Check className={className} aria-hidden="true" />;
    case "error":
      return <AlertCircle className={className} aria-hidden="true" />;
    case "unknown":
      return <CircleHelp className={className} aria-hidden="true" />;
    case "needs_confirmation":
      return <ShieldAlert className={className} aria-hidden="true" />;
  }
}

/** W17b: where a successful `propose_plan` call can be reviewed, or null. */
export function planReviewHref(toolCall: Pick<StreamingToolCall, "name" | "status" | "result">): string | null {
  if (toolCall.name !== "propose_plan" || toolCall.status !== "completed" || !toolCall.result) return null;
  let data: unknown;
  try {
    data = JSON.parse(toolCall.result);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const planId = typeof record.planId === "string" ? record.planId : null;
  const projectId = typeof record.projectId === "string" ? record.projectId : null;
  if (!planId || !projectId) return null;
  return `/projects/plans?id=${encodeURIComponent(projectId)}&plan=${encodeURIComponent(planId)}`;
}

/** W19b: where a successful `propose_knowledge` call waits for approval, or null. */
export function knowledgeReviewHref(toolCall: Pick<StreamingToolCall, "name" | "status" | "result">): string | null {
  if (toolCall.name !== "propose_knowledge" || toolCall.status !== "completed" || !toolCall.result) return null;
  let data: unknown;
  try {
    data = JSON.parse(toolCall.result);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const projectId = (data as Record<string, unknown>).projectId;
  return typeof projectId === "string" ? `/projects/knowledge?id=${encodeURIComponent(projectId)}` : null;
}

export function formatToolName(name?: string | null): string {
  const safeName = name?.trim() || "tool";
  return safeName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ToolCallCard({ toolCall, controls }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const status = STATUS_META[toolCall.status] ?? STATUS_META.completed;
  const effect = toolCall.effect ? EFFECT_META[toolCall.effect] : null;
  const confirmation = toolCall.confirmation;
  // An unknown outcome is safety-relevant: always visible, not behind the toggle.
  const showOutcomeNote = toolCall.status === "unknown" && toolCall.error;
  // ...and so is its resolution, once the server recorded what really happened.
  const reconciled = toolCall.reconciled;

  return (
    <div
      className="space-y-1.5"
      data-tool-status={toolCall.status}
      data-tool-effect={toolCall.effect ?? "unknown"}
      data-tool-reconciled={reconciled ? reconciled.status : undefined}
    >
      <div className="overflow-hidden rounded-sm border border-linear-border bg-linear-bg-tertiary">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-linear-text-secondary transition-colors hover:bg-linear-bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-linear-accent"
        >
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")}
            aria-hidden="true"
          />
          <StatusIcon status={toolCall.status} />
          <span className="min-w-0 flex-1 truncate font-medium">{formatToolName(toolCall.name)}</span>
          {effect && (
            <span
              className={cn("shrink-0 rounded-sm border px-1.5 py-px text-[10px] uppercase tracking-wide", effect.className)}
              title={effect.description}
            >
              {effect.label}
              <span className="sr-only"> action: {effect.description}</span>
            </span>
          )}
          <span className={cn("shrink-0 text-[10px]", status.className)}>{status.label}</span>
        </button>
        {showOutcomeNote && (
          <p className="border-t border-linear-border px-3 py-1.5 text-[11px] text-warning">
            {toolCall.error?.message}
            {toolCall.error?.hint ? ` ${toolCall.error.hint}` : ""}
          </p>
        )}
        {planReviewHref(toolCall) && (
          <Link
            href={planReviewHref(toolCall) ?? "#"}
            className="flex items-center gap-1.5 border-t border-linear-border px-3 py-1.5 text-[11px] text-linear-accent hover:underline"
          >
            <ClipboardList className="h-3 w-3" aria-hidden="true" />
            Review the plan — nothing is created until you approve it
          </Link>
        )}
        {knowledgeReviewHref(toolCall) && (
          <Link
            href={knowledgeReviewHref(toolCall) ?? "#"}
            className="flex items-center gap-1.5 border-t border-linear-border px-3 py-1.5 text-[11px] text-linear-accent hover:underline"
          >
            <BookOpen className="h-3 w-3" aria-hidden="true" />
            Review the proposal — agents get it only after you approve it
          </Link>
        )}
        {reconciled && (
          <p
            className={cn(
              "border-t border-linear-border px-3 py-1.5 text-[11px]",
              reconciled.status === "succeeded" ? "text-success" : "text-linear-text-secondary",
            )}
            role="status"
          >
            {reconciled.status === "succeeded"
              ? "Confirmed after the interruption: this change was applied."
              : "Confirmed after the interruption: this change was not applied."}
          </p>
        )}
        {expanded && (
          <div id={detailsId} className="space-y-2 border-t border-linear-border px-3 py-2">
            {toolCall.error && toolCall.status === "error" && (
              <p className="text-[11px] text-destructive">
                {toolCall.error.message}
                {toolCall.error.hint ? ` ${toolCall.error.hint}` : ""}
              </p>
            )}
            {toolCall.arguments && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-linear-text-tertiary">Input</span>
                <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-xs text-linear-text-secondary">
                  {toolCall.arguments}
                </pre>
              </div>
            )}
            {toolCall.result && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-linear-text-tertiary">Result</span>
                <pre
                  className={cn(
                    "mt-0.5 whitespace-pre-wrap break-all font-mono text-xs",
                    toolCall.status === "error" ? "text-destructive" : "text-linear-text-secondary",
                  )}
                >
                  {toolCall.result}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
      {confirmation && (
        <ConfirmationCard
          confirmation={confirmation}
          state={controls?.confirmations[confirmation.code]}
          interactive={Boolean(controls)}
          busy={controls?.status === "streaming"}
          onConfirm={controls?.confirm}
          onDismiss={controls?.dismissConfirmation}
        />
      )}
    </div>
  );
}
