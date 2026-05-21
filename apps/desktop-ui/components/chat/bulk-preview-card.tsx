"use client";

import { useState } from "react";
import { Check, X, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { IssueCard } from "./issue-card";

interface PreviewIssue {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
}

interface BulkPreviewCardProps {
  issues: PreviewIssue[];
  onConfirm: (issues: PreviewIssue[]) => void;
  onCancel: () => void;
}

export function BulkPreviewCard({ issues, onConfirm, onCancel }: BulkPreviewCardProps) {
  const [items, setItems] = useState(issues);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditValue(items[idx].title);
  };

  const saveEdit = () => {
    if (editingIdx === null) return;
    const next = [...items];
    next[editingIdx] = { ...next[editingIdx], title: editValue };
    setItems(next);
    setEditingIdx(null);
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  return (
    <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary overflow-hidden">
      <div className="px-3 py-2 border-b border-linear-border flex items-center justify-between">
        <span className="text-xs text-linear-text-secondary">{items.length} issues to create</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-6 items-center gap-1 rounded-sm px-2 text-xs text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(items)}
            disabled={items.length === 0}
            className="flex h-6 items-center gap-1 rounded-sm px-2 text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 transition-colors"
          >
            <Check className="h-3 w-3" />
            Create all
          </button>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-linear-border">
        {items.map((issue, idx) => (
          <div key={idx} className="flex items-center gap-2 px-3 py-1.5 group">
            {editingIdx === idx ? (
              <div className="flex-1 flex items-center gap-1">
                <input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                  onBlur={saveEdit}
                  className="flex-1 bg-transparent text-xs text-linear-text outline-none"
                  autoFocus
                />
              </div>
            ) : (
              <div className="flex-1 min-w-0">
                <IssueCard title={issue.title} status={issue.status} priority={issue.priority} className="border-0 bg-transparent p-0" />
              </div>
            )}
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button type="button" onClick={() => startEdit(idx)} className="h-5 w-5 flex items-center justify-center rounded-sm hover:bg-linear-bg-secondary text-linear-text-tertiary">
                <Pencil className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => removeItem(idx)} className="h-5 w-5 flex items-center justify-center rounded-sm hover:bg-destructive/10 text-linear-text-tertiary hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
