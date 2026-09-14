"use client";

import { useProject } from "@/hooks/use-project";

export function ChatEmptyState() {
  const { activeProject } = useProject();
  const projectName = (activeProject?.name || "your workspace").toLowerCase();

  return (
    <div className="flex flex-col items-center text-center">
      <h1 className="text-3xl font-medium text-linear-text tracking-tight">
        <span className="text-linear-text-tertiary">brainstorm</span>{" "}
        <span className="text-linear-accent">{projectName}</span>
      </h1>
    </div>
  );
}
