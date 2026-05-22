"use client";

import { cn } from "@/lib/utils";
import { Check, ChevronDown, FolderKanban } from "lucide-react";
import { useProject } from "@/hooks/use-project";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ScopePickerProps {
  className?: string;
}

export function ScopePicker({ className }: ScopePickerProps) {
  const { activeProject, projects, setActiveProject } = useProject();
  const activeProjectName = activeProject?.name.toLowerCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 min-w-[180px] max-w-[280px] items-center gap-2 rounded-sm border border-linear-border bg-linear-bg-secondary px-2.5 text-xs text-linear-text shadow-sm outline-none transition-colors hover:border-linear-border-hover hover:bg-linear-bg-tertiary focus:border-linear-border-hover",
            className
          )}
          aria-label="Select project for chat"
        >
          <FolderKanban className="h-3.5 w-3.5 shrink-0 text-linear-text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeProjectName ?? "select project"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-linear-text-tertiary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-[280px] max-h-[320px] overflow-y-auto border-linear-border bg-linear-bg-secondary p-1 shadow-elevation"
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-linear-text-tertiary">
          Project
        </DropdownMenuLabel>
        {projects.map((project) => {
          const selected = project.id === activeProject?.id;
          return (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => setActiveProject(project)}
              className={cn(
                "min-h-8 cursor-default gap-2 rounded-sm px-2 py-1.5 text-xs text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text",
                selected && "bg-linear-bg-tertiary"
              )}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full border border-linear-border"
                style={{ backgroundColor: project.color || "transparent" }}
              />
              <span className="min-w-0 flex-1 truncate">{project.name.toLowerCase()}</span>
              {selected && <Check className="h-3.5 w-3.5 text-linear-accent" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
