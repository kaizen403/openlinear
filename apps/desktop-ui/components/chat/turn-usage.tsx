"use client";

import { cn } from "@/lib/utils";
import type { ChatTurnUsage } from "@/lib/api/chat";
import { describeTurnUsage } from "./usage-format";

interface TurnUsageFooterProps {
  usage: ChatTurnUsage;
  className?: string;
}

/**
 * Small, collapsed usage line under an assistant turn: tokens (incl. cache
 * reads) and cost, "cost unknown" when the server has no price. Expands to
 * the full breakdown; `<details>` keeps it keyboard operable.
 */
export function TurnUsageFooter({ usage, className }: TurnUsageFooterProps) {
  const copy = describeTurnUsage(usage);
  return (
    <details className={cn("group/usage text-[10px] text-linear-text-tertiary", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm px-0.5 hover:text-linear-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-linear-accent [&::-webkit-details-marker]:hidden">
        <span className="sr-only">Usage for this reply: </span>
        {copy.label}
      </summary>
      <ul className="mt-1 space-y-0.5 pl-0.5">
        {copy.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}
