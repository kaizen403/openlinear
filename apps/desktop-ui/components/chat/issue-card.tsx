"use client";

import { cn } from "@/lib/utils";
import { STATUS_COLORS, PRIORITY_COLORS } from "@/lib/design-tokens";

interface IssueCardProps {
  identifier?: string;
  title: string;
  status?: string;
  priority?: string;
  assignee?: string;
  className?: string;
}

export function IssueCard({ identifier, title, status, priority, assignee, className }: IssueCardProps) {
  const statusColor = status ? STATUS_COLORS[status as keyof typeof STATUS_COLORS] : null;
  const priorityColor = priority ? PRIORITY_COLORS[priority as keyof typeof PRIORITY_COLORS] : null;

  return (
    <div className={cn("rounded-sm border border-linear-border bg-linear-bg-secondary px-3 py-2 space-y-1", className)}>
      <div className="flex items-center gap-2">
        {identifier && <span className="text-[10px] font-mono text-linear-text-tertiary">{identifier}</span>}
        <span className="text-xs text-linear-text truncate">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {statusColor && (
          <span className={cn("inline-flex items-center gap-1 text-[10px]", statusColor.text)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", statusColor.dot)} />
            {status}
          </span>
        )}
        {priorityColor && (
          <span className={cn("text-[10px]", priorityColor.text)}>{priority}</span>
        )}
        {assignee && <span className="text-[10px] text-linear-text-tertiary ml-auto">@{assignee}</span>}
      </div>
    </div>
  );
}
