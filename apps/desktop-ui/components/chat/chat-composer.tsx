"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Send, Square, Plus, Mic, Shield, User, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

interface ChatComposerProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  onNewChat?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  centered?: boolean;
}

function PermissionBadge() {
  const { activeWorkspace } = useWorkspace();
  const role = activeWorkspace?.role || "member";

  const config = {
    owner:   { text: "Full access", color: "text-orange-400", icon: Shield },
    admin:   { text: "Full access", color: "text-orange-400", icon: Shield },
    member:  { text: "Member",      color: "text-linear-text-secondary", icon: User },
    viewer:  { text: "View only",   color: "text-linear-text-tertiary", icon: Eye },
  } as const;

  const c = config[role as keyof typeof config] || config.member;
  const Icon = c.icon;

  return (
    <span className="flex items-center gap-1 text-[11px]">
      <Icon className={cn("h-3 w-3", c.color)} />
      <span className={c.color}>{c.text}</span>
    </span>
  );
}

export function ChatComposer({
  onSend,
  onStop,
  onNewChat,
  isStreaming = false,
  disabled = false,
  placeholder = "Ask anything about your workspace...",
  centered = false,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "56px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isStreaming) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "56px";
  }, [value, disabled, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div
      className={cn(
        "w-full max-w-3xl mx-auto",
        centered && "flex flex-col items-center justify-center"
      )}
    >
      <div className="relative w-full rounded-sm border border-linear-border bg-linear-bg-secondary shadow-card">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 pr-28 text-sm text-linear-text placeholder:text-linear-text-tertiary focus:outline-none disabled:opacity-50"
          style={{ minHeight: "56px", maxHeight: "240px" }}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="flex items-center justify-between border-t border-linear-border px-3 py-2">
          <div className="flex items-center gap-2">
            {onNewChat && !isStreaming && (
              <button
                type="button"
                onClick={onNewChat}
                className="flex h-7 w-7 items-center justify-center rounded-sm text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                aria-label="New chat"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
            <PermissionBadge />
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] bg-linear-bg-tertiary text-linear-text-secondary border border-linear-border">
              Kimi K2
            </span>
            <span className="flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] bg-linear-bg-tertiary text-linear-text-secondary border border-linear-border">
              5.5 High
            </span>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
              aria-label="Voice input"
            >
              <Mic className="h-4 w-4" />
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="flex h-7 w-7 items-center justify-center rounded-sm bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                aria-label="Stop generating"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!value.trim() || disabled}
                className="flex h-7 w-7 items-center justify-center rounded-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Send message"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
