import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
  /**
   * Visual size of the empty state. `default` is used for full-page empties;
   * `compact` is used for small surfaces (popovers, narrow columns).
   */
  size?: "default" | "compact"
}

/**
 * Themed empty state for dark surfaces. Use anywhere a list/board/page
 * has no items to display, in place of ad-hoc one-off "No X yet" markup.
 *
 * For loading states matching the list shape, render <Skeleton /> blocks
 * instead — this component is for the *empty* (loaded, but zero items) state.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "default",
  className,
  ...props
}: EmptyStateProps) {
  const isCompact = size === "compact"

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        isCompact ? "py-6 px-3 gap-2" : "py-20 px-6 gap-3",
        className
      )}
      {...props}
    >
      {Icon && (
        <div
          className={cn(
            "rounded-sm bg-linear-bg-tertiary border border-linear-border flex items-center justify-center",
            isCompact ? "w-9 h-9 mb-1" : "w-12 h-12 mb-1"
          )}
        >
          <Icon
            className={cn(
              "text-linear-text-tertiary",
              isCompact ? "w-4 h-4" : "w-6 h-6"
            )}
          />
        </div>
      )}
      <h3
        className={cn(
          "font-medium text-linear-text",
          isCompact ? "text-xs" : "text-sm"
        )}
      >
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            "text-linear-text-tertiary max-w-sm",
            isCompact ? "text-[11px]" : "text-sm"
          )}
        >
          {description}
        </p>
      )}
      {action && <div className={cn(isCompact ? "mt-1" : "mt-2")}>{action}</div>}
    </div>
  )
}
