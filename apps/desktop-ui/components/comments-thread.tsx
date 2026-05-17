"use client"

import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { Loader2, Send, Pencil, Trash2, X, Check } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { MarkdownView } from "@/components/markdown-view"
import { useAuth } from "@/hooks/use-auth"
import { useSSESubscription } from "@/providers/sse-provider"
import { cn } from "@/lib/utils"
import {
  fetchComments,
  createComment,
  updateComment,
  deleteComment,
  fetchTaskTeamId,
  fetchTeamMembers,
  type Comment,
} from "@/lib/api/comments"
import type { TeamMember } from "@/lib/api/types"

interface CommentsThreadProps {
  taskId: string
}

interface MentionState {
  open: boolean
  query: string
  startIndex: number
  highlight: number
}

const MENTION_CLOSED: MentionState = { open: false, query: "", startIndex: -1, highlight: 0 }

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffSec = Math.round((now - then) / 1000)
  if (diffSec < 5) return "just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString()
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

function friendlyError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "")
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_")
  if (!raw || normalized === "validation_error" || normalized === "validation_failed") {
    return fallback
  }
  return raw
}

export function CommentsThread({ taskId }: CommentsThreadProps) {
  const { user } = useAuth()
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [body, setBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const [mention, setMention] = useState<MentionState>(MENTION_CLOSED)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setComments([])
    setMembers([])

    ;(async () => {
      try {
        const [commentList, taskMeta] = await Promise.all([
          fetchComments(taskId),
          fetchTaskTeamId(taskId),
        ])
        if (cancelled) return
        setComments(commentList.comments)
        if (taskMeta.teamId) {
          try {
            const m = await fetchTeamMembers(taskMeta.teamId)
            if (!cancelled) setMembers(m)
          } catch {
            if (!cancelled) setMembers([])
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(friendlyError(err, "Failed to load comments"))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [taskId])

  useSSESubscription(useCallback((eventType, data) => {
    const evt = eventType as string
    const payload = data as unknown as {
      taskId?: string
      comment?: Comment
      id?: string
    }
    if (payload.taskId !== taskId) return

    if (evt === "comment:created" && payload.comment) {
      setComments((prev) => (prev.some((c) => c.id === payload.comment!.id) ? prev : [...prev, payload.comment!]))
    } else if (evt === "comment:updated" && payload.comment) {
      setComments((prev) => prev.map((c) => (c.id === payload.comment!.id ? payload.comment! : c)))
    } else if (evt === "comment:deleted" && payload.id) {
      setComments((prev) => prev.filter((c) => c.id !== payload.id))
    }
  }, [taskId]))

  const memberCandidates = useMemo(() => {
    if (!mention.open) return []
    const q = mention.query.toLowerCase()
    return members
      .filter((m) => m.user)
      .filter((m) => m.user!.username.toLowerCase().includes(q))
      .slice(0, 6)
  }, [members, mention])

  const updateMentionFromCaret = useCallback((value: string, caret: number) => {
    const textBefore = value.slice(0, caret)
    const atIdx = textBefore.lastIndexOf("@")
    if (atIdx === -1) {
      setMention(MENTION_CLOSED)
      return
    }
    const charBeforeAt = atIdx === 0 ? " " : textBefore[atIdx - 1]
    if (charBeforeAt && !/\s/.test(charBeforeAt)) {
      setMention(MENTION_CLOSED)
      return
    }
    const between = textBefore.slice(atIdx + 1)
    if (/\s/.test(between)) {
      setMention(MENTION_CLOSED)
      return
    }
    if (!/^[a-zA-Z0-9_-]*$/.test(between)) {
      setMention(MENTION_CLOSED)
      return
    }
    setMention({ open: true, query: between, startIndex: atIdx, highlight: 0 })
  }, [])

  const insertMention = useCallback((username: string) => {
    if (mention.startIndex < 0) return
    const ta = textareaRef.current
    if (!ta) return
    const before = body.slice(0, mention.startIndex)
    const after = body.slice(mention.startIndex + 1 + mention.query.length)
    const next = `${before}@${username} ${after}`
    setBody(next)
    setMention(MENTION_CLOSED)
    requestAnimationFrame(() => {
      const pos = (before + "@" + username + " ").length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    })
  }, [body, mention])

  const onTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setBody(v)
    updateMentionFromCaret(v, e.target.selectionStart ?? v.length)
  }

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && memberCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMention((m) => ({ ...m, highlight: (m.highlight + 1) % memberCandidates.length }))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMention((m) => ({
          ...m,
          highlight: (m.highlight - 1 + memberCandidates.length) % memberCandidates.length,
        }))
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const pick = memberCandidates[mention.highlight]?.user
        if (pick) insertMention(pick.username)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMention(MENTION_CLOSED)
        return
      }
    }
    if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) && !mention.open) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const handleSubmit = async () => {
    const text = body.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      const created = await createComment(taskId, text)
      setComments((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]))
      setBody("")
      setMention(MENTION_CLOSED)
    } catch (err) {
      setLoadError(friendlyError(err, "Failed to post comment"))
    } finally {
      setSubmitting(false)
    }
  }

  const startEdit = (c: Comment) => {
    setEditingId(c.id)
    setEditDraft(c.body)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditDraft("")
  }

  const saveEdit = async (id: string) => {
    const text = editDraft.trim()
    if (!text) return
    try {
      const updated = await updateComment(id, text)
      setComments((prev) => prev.map((c) => (c.id === id ? updated : c)))
      cancelEdit()
    } catch (err) {
      setLoadError(friendlyError(err, "Failed to update comment"))
    }
  }

  const remove = async (id: string) => {
    const prev = comments
    setComments((cs) => cs.filter((c) => c.id !== id))
    try {
      await deleteComment(id)
    } catch (err) {
      setComments(prev)
      setLoadError(friendlyError(err, "Failed to delete comment"))
    }
  }

  return (
    <section className="border-t border-linear-border pt-6 mt-6">
      <h2 className="text-sm font-medium text-linear-text-secondary mb-4 flex items-center gap-2">
        <span className="w-1 h-1 rounded-full bg-linear-text-secondary" />
        Comments
        {comments.length > 0 && (
          <span className="text-xs text-linear-text-tertiary">({comments.length})</span>
        )}
      </h2>

      {loadError && (
        <div className="mb-3 px-3 py-2 rounded-sm border border-red-500/30 bg-red-500/10 text-xs text-red-400">
          {loadError}
        </div>
      )}

      <div className="space-y-4 mb-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-linear-text-tertiary">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading comments…
          </div>
        ) : comments.length === 0 ? (
          <p className="text-sm text-linear-text-tertiary">No comments yet. Be the first to leave one.</p>
        ) : (
          comments.map((c) => {
            const isOwn = !!user && c.userId === user.id
            const isEditing = editingId === c.id
            return (
              <div key={c.id} className="flex gap-3">
                <Avatar className="h-8 w-8 rounded-full flex-shrink-0">
                  {c.user.avatarUrl && <AvatarImage src={c.user.avatarUrl} alt={c.user.username} className="object-cover" />}
                  <AvatarFallback className="text-[10px] bg-linear-bg-secondary text-linear-text-secondary border border-linear-border">
                    {initialsOf(c.user.username)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-linear-text">{c.user.username}</span>
                    <span className="text-xs text-linear-text-tertiary" title={new Date(c.createdAt).toLocaleString()}>
                      {formatRelativeTime(c.createdAt)}
                    </span>
                    {c.updatedAt !== c.createdAt && (
                      <span className="text-[10px] text-linear-text-tertiary">(edited)</span>
                    )}
                    {isOwn && !isEditing && (
                      <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => startEdit(c)}
                          className="p-1 rounded text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-secondary"
                          aria-label="Edit comment"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => void remove(c.id)}
                          className="p-1 rounded text-linear-text-tertiary hover:text-red-400 hover:bg-red-500/10"
                          aria-label="Delete comment"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation()
                            cancelEdit()
                          }
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            void saveEdit(c.id)
                          }
                        }}
                        className="w-full text-sm text-linear-text bg-linear-bg-secondary border border-linear-border rounded-sm p-2 outline-none focus:border-linear-accent resize-y min-h-[60px]"
                        rows={3}
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" className="h-7 px-3" onClick={() => void saveEdit(c.id)}>
                          <Check className="w-3 h-3 mr-1" /> Save
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-3" onClick={cancelEdit}>
                          <X className="w-3 h-3 mr-1" /> Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="group">
                      <MarkdownView body={c.body} />
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="relative">
        <div className="border border-linear-border rounded-sm bg-linear-bg-secondary focus-within:border-linear-accent transition-colors">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={onTextareaChange}
            onKeyDown={onTextareaKeyDown}
            onBlur={() => setTimeout(() => setMention(MENTION_CLOSED), 120)}
            placeholder="Leave a comment… use @ to mention a teammate"
            rows={3}
            className="w-full text-sm bg-transparent text-linear-text placeholder:text-linear-text-tertiary p-3 outline-none resize-y min-h-[72px]"
          />
          <div className="flex items-center justify-between px-3 py-2 border-t border-linear-border">
            <span className="text-xs text-linear-text-tertiary">
              {members.length > 0 ? "⌘+Enter to send · @ to mention" : "⌘+Enter to send"}
            </span>
            <Button
              size="sm"
              className="h-7 px-3"
              disabled={!body.trim() || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <Send className="w-3 h-3 mr-1" />
              )}
              Comment
            </Button>
          </div>
        </div>

        {mention.open && memberCandidates.length > 0 && (
          <div
            className="absolute left-0 bottom-full mb-1 z-50 w-64 rounded-sm border border-linear-border bg-linear-bg shadow-lg overflow-hidden"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-linear-text-tertiary border-b border-linear-border">
              Team members
            </div>
            {memberCandidates.map((m, idx) => {
              const u = m.user!
              const active = idx === mention.highlight
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => insertMention(u.username)}
                  onMouseEnter={() => setMention((s) => ({ ...s, highlight: idx }))}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm",
                    active ? "bg-linear-accent/15 text-linear-text" : "text-linear-text-secondary hover:bg-linear-bg-secondary"
                  )}
                >
                  <Avatar className="h-5 w-5 rounded-full">
                    {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.username} className="object-cover" />}
                    <AvatarFallback className="text-[9px] bg-linear-bg-secondary border border-linear-border">
                      {initialsOf(u.username)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">@{u.username}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
