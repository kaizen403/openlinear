"use client";

import { cn } from "@/lib/utils";
import { ListChecks, Search, Sparkles, TrendingUp } from "lucide-react";

interface ChatSuggestionsProps {
  onSelect: (text: string) => void;
}

const SUGGESTIONS = [
  {
    icon: TrendingUp,
    text: "Summarize this project's current status and blockers",
  },
  {
    icon: Search,
    text: "Show open high priority issues in this project",
  },
  {
    icon: ListChecks,
    text: "Create a focused task list for the next implementation pass",
  },
  {
    icon: Sparkles,
    text: "Find stale or unclear tasks that need better specs",
  },
];

export function ChatSuggestions({ onSelect }: ChatSuggestionsProps) {
  return (
    <div className="w-full max-w-3xl mx-auto">
      {SUGGESTIONS.map((s, i) => {
        const Icon = s.icon;
        const isLast = i === SUGGESTIONS.length - 1;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelect(s.text)}
            className={cn(
              "flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors",
              !isLast && "border-b border-linear-border/40"
            )}
          >
            <Icon className="h-4 w-4 text-linear-text-tertiary shrink-0" />
            <span>{s.text}</span>
          </button>
        );
      })}
    </div>
  );
}
