"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useHotkeys } from "react-hotkeys-hook"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type Shortcut = {
  keys: string[]
  description: string
}

type ShortcutGroup = {
  title: string
  shortcuts: Shortcut[]
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["g", "i"], description: "Go to Inbox" },
      { keys: ["g", "m"], description: "Go to My Issues" },
      { keys: ["g", "p"], description: "Go to Projects" },
      { keys: ["g", "t"], description: "Go to Teams" },
      { keys: ["g", "s"], description: "Go to Settings" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { keys: ["c"], description: "New task (quick capture)" },
      { keys: ["/"], description: "Search" },
      { keys: ["⌘", "K"], description: "Command palette" },
      { keys: ["?"], description: "Keyboard shortcuts" },
      { keys: ["Esc"], description: "Close overlay" },
    ],
  },
  {
    title: "Editing",
    shortcuts: [{ keys: ["⌘", "Enter"], description: "Save" }],
  },
]

function isTypingTarget(target: EventTarget | Element | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target.isContentEditable) return true
  return false
}

export function ShortcutsOverlay() {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const filterEnabled = useCallback(() => {
    return !isTypingTarget(document.activeElement)
  }, [])

  useHotkeys(
    "shift+/",
    (e) => {
      e.preventDefault()
      setOpen((v: boolean) => !v)
    },
    { enableOnFormTags: false, enableOnContentEditable: false, enabled: filterEnabled }
  )

  useHotkeys(
    "c",
    (e) => {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent("openlinear:new-task"))
    },
    { enableOnFormTags: false, enableOnContentEditable: false, enabled: filterEnabled }
  )

  useHotkeys(
    "escape",
    () => setOpen(false),
    { enabled: open, enableOnFormTags: true }
  )

  useEffect(() => {
    let pendingG = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const reset = () => {
      pendingG = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as Element | null)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const k = e.key.toLowerCase()

      if (pendingG) {
        const map: Record<string, string> = {
          i: "/inbox",
          m: "/my-issues",
          p: "/projects",
          t: "/teams",
          s: "/settings",
        }
        const path = map[k]
        if (path) {
          e.preventDefault()
          router.push(path)
        }
        reset()
        return
      }

      if (k === "g") {
        pendingG = true
        timer = setTimeout(reset, 1200)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      if (timer) clearTimeout(timer)
    }
  }, [router])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-sans text-2xl tracking-tight">
            Keyboard Shortcuts
          </SheetTitle>
          <SheetDescription>
            Navigate OpenLinear faster. Press{" "}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
              ?
            </kbd>{" "}
            anytime to toggle this panel.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <ul className="space-y-2">
                {group.shortcuts.map((s) => (
                  <li
                    key={s.description}
                    className="flex items-center justify-between gap-4 rounded-sm border border-border/40 bg-muted/20 px-3 py-2"
                  >
                    <span className="text-sm">{s.description}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((key, i) => (
                        <kbd
                          key={`${s.description}-${i}`}
                          className="min-w-[1.75rem] rounded border border-border bg-background px-1.5 py-0.5 text-center font-mono text-xs"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
