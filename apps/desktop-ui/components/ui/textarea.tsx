import * as React from "react"

import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      className={cn(
        "flex min-h-[80px] w-full rounded-sm border border-input bg-transparent px-2.5 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-disabled",
        focusRing,
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
