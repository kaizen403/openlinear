"use client";

import { cn } from "@/lib/utils";
import { Cloud, LayoutGrid } from "lucide-react";

interface ChatSuggestionsProps {
  onSelect: (text: string) => void;
}

const SUGGESTIONS = [
  {
    icon: Cloud,
    text: "Create tasks for the next sprint and assign them to the team",
  },
  {
    icon: Cloud,
    text: "Show all high priority issues that are unassigned",
  },
  {
    icon: Cloud,
    text: "Summarize project status and recent activity",
  },
  {
    icon: LayoutGrid,
    text: "Connect your favorite apps and integrations",
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
