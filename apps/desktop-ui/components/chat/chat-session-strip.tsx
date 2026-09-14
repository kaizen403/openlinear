"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { MessageSquare, ChevronRight } from "lucide-react";
import type { ChatSession } from "@/lib/api/chat";

interface ChatSessionStripProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function ChatSessionStrip({ sessions, activeSessionId, onSelect, className }: ChatSessionStripProps) {
  const [expanded, setExpanded] = useState(false);

  if (sessions.length === 0) return null;

  const visibleCount = 5;
  const visible = expanded ? sessions.slice(0, 20) : sessions.slice(0, visibleCount);
  const hasMore = sessions.length > visibleCount;

  return (
    <div className={cn("relative", className)}>
      <div className="flex items-center gap-1.5 overflow-x-auto py-2 scrollbar-none">
        {visible.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelect(session.id)}
            className={cn(
              "flex items-center gap-1.5 shrink-0 rounded-sm px-2.5 py-1 text-xs transition-colors",
              session.id === activeSessionId
                ? "bg-linear-bg-tertiary text-linear-text"
                : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-secondary"
            )}
          >
            <MessageSquare className="h-3 w-3" />
            <span className="max-w-[120px] truncate">
              {session.title || "New chat"}
            </span>
            <span className="text-linear-text-tertiary">
              {relativeTime(session.lastMessageAt || session.createdAt)}
            </span>
          </button>
        ))}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1 shrink-0 rounded-sm px-2.5 py-1 text-xs text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-secondary transition-colors"
          >
            View all chats
            <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </div>
      {!expanded && hasMore && (
        <div className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-linear-bg to-transparent pointer-events-none" />
      )}
    </div>
  );
}
