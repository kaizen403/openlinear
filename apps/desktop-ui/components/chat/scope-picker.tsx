"use client";

import { cn } from "@/lib/utils";
import { Globe, FolderKanban } from "lucide-react";
import { useWorkspace } from "@/hooks/use-workspace";
import { useProject } from "@/hooks/use-project";

interface ScopePickerProps {
  scope: "workspace" | "project";
  onScopeChange: (scope: "workspace" | "project") => void;
  className?: string;
}

export function ScopePicker({ scope, onScopeChange, className }: ScopePickerProps) {
  const { activeWorkspace } = useWorkspace();
  const { activeProject } = useProject();

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={() => onScopeChange("workspace")}
        className={cn(
          "flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] transition-colors",
          scope === "workspace"
            ? "bg-linear-bg-tertiary text-linear-text"
            : "text-linear-text-tertiary hover:text-linear-text-secondary"
        )}
      >
        <Globe className="h-3 w-3" />
        {activeWorkspace?.name || "Workspace"}
      </button>
      {activeProject && (
        <button
          type="button"
          onClick={() => onScopeChange("project")}
          className={cn(
            "flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] transition-colors",
            scope === "project"
              ? "bg-linear-bg-tertiary text-linear-text"
              : "text-linear-text-tertiary hover:text-linear-text-secondary"
          )}
        >
          <FolderKanban className="h-3 w-3" />
          {activeProject.name}
        </button>
      )}
    </div>
  );
}
