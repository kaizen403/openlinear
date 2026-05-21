"use client";

import { useProject } from "@/hooks/use-project";

export function ChatEmptyState() {
  const { activeProject } = useProject();
  const projectName = activeProject?.name || "your workspace";

  return (
    <div className="flex flex-col items-center text-center">
      <h1 className="text-3xl font-medium text-linear-text tracking-tight">
        <span className="text-linear-text-tertiary">let&apos;s work on</span>{" "}
        <span className="font-semibold text-primary">{projectName}</span>
      </h1>
    </div>
  );
}
