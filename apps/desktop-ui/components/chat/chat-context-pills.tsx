"use client";

import { useAuth } from "@/hooks/use-auth";
import { useProject } from "@/hooks/use-project";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { Building2, FolderKanban, Shield, User, Eye, ChevronDown } from "lucide-react";

interface ChatContextPillsProps {
  className?: string;
}

export function ChatContextPills({ className }: ChatContextPillsProps) {
  const { user } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const { activeProject } = useProject();

  const role = activeWorkspace?.role || "member";

  const roleConfig = {
    owner:   { text: "Full access", color: "text-orange-400", icon: Shield },
    admin:   { text: "Full access", color: "text-orange-400", icon: Shield },
    member:  { text: "Member",      color: "text-linear-text-secondary", icon: User },
    viewer:  { text: "View only",   color: "text-linear-text-tertiary", icon: Eye },
  } as const;

  const rc = roleConfig[role as keyof typeof roleConfig] || roleConfig.member;
  const RoleIcon = rc.icon;

  const pills: { icon: React.ElementType; text: string; active?: boolean; colorClass?: string }[] = [];

  if (activeWorkspace) {
    pills.push({ icon: Building2, text: activeWorkspace.name, active: true });
  }

  if (activeProject) {
    pills.push({ icon: FolderKanban, text: activeProject.name, active: true });
  }

  pills.push({ icon: RoleIcon, text: rc.text, active: false, colorClass: rc.color });

  return (
    <div className={cn("flex items-center justify-center gap-2 flex-wrap", className)}>
      {pills.map((pill, i) => {
        const Icon = pill.icon;
        return (
          <button
            key={i}
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs border transition-colors",
              pill.active
                ? "bg-linear-bg-tertiary text-linear-text border-linear-border hover:border-linear-border-hover"
                : "bg-linear-bg-tertiary text-linear-text-secondary border-linear-border hover:text-linear-text hover:border-linear-border-hover"
            )}
          >
            <Icon className={cn("h-3.5 w-3.5 shrink-0", pill.colorClass || "text-linear-text-tertiary")} />
            <span className="max-w-[140px] truncate">{pill.text}</span>
            <ChevronDown className="h-3 w-3 text-linear-text-tertiary" />
          </button>
        );
      })}
    </div>
  );
}
