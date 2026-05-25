"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatPanelHandoff } from "@/hooks/use-chat-panel-handoff";

export function BrainstormPopup() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { queueQuery } = useChatPanelHandoff();

  const close = useCallback(() => {
    setOpen(false);
    setValue("");
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
    };
    window.addEventListener("openlinear:open-chat-popup", onOpen);
    return () => {
      window.removeEventListener("openlinear:open-chat-popup", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    queueQuery(trimmed);
    close();
  }, [value, queueQuery, close]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="popup-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
            className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            key="popup-panel"
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
            className={cn(
              "fixed left-1/2 top-1/2 z-[9999] -translate-x-1/2 -translate-y-1/2",
              "w-[min(560px,calc(100vw-2rem))]",
              "bg-linear-bg-secondary border border-linear-border rounded-lg shadow-2xl",
              "p-3",
            )}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask about this project..."
                rows={2}
                className={cn(
                  "flex-1 resize-none bg-transparent outline-none",
                  "text-sm text-linear-text placeholder:text-linear-text-tertiary",
                  "px-2 py-1.5",
                )}
              />
              <button
                type="button"
                onClick={submit}
                disabled={!value.trim()}
                aria-label="Send"
                className={cn(
                  "shrink-0 rounded-md p-2",
                  "text-linear-text-secondary hover:text-linear-text",
                  "hover:bg-linear-bg-tertiary",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                  "transition-colors",
                )}
              >
                <Send className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className={cn(
                  "shrink-0 rounded-md p-2",
                  "text-linear-text-tertiary hover:text-linear-text",
                  "hover:bg-linear-bg-tertiary",
                  "transition-colors",
                )}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
