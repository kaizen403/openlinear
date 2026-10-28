/**
 * Review drafts: inline comments and the follow-up message, kept per task in
 * localStorage until they are sent to the agent (then the sent ones are
 * removed). Pure functions over an injectable storage so tests and the
 * benchmark never touch the real one.
 *
 * Stored values are user-written text; they are only ever rendered as text.
 */

export type CommentSide = "old" | "new"

export interface DraftComment {
  id: string
  path: string
  /** Absent for a comment on the whole file. */
  line?: number
  side?: CommentSide
  body: string
  /** Diff revision the comment was written against (outdated detection). */
  revision: string | null
  /** The anchored line's text when the comment was written (≤ 200 chars). */
  excerpt?: string
  createdAt: number
  updatedAt: number
}

export interface ReviewDraftState {
  message: string
  comments: DraftComment[]
}

export const DRAFT_STORAGE_PREFIX = "openlinear:review-drafts:v1:"
export const MAX_DRAFT_COMMENTS = 100
export const MAX_COMMENT_CHARS = 8_000
export const MAX_MESSAGE_CHARS = 16_000
export const MAX_EXCERPT_CHARS = 200

export const EMPTY_DRAFTS: ReviewDraftState = Object.freeze({ message: "", comments: [] }) as ReviewDraftState

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function draftStorageKey(taskId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${taskId}`
}

/** The browser's localStorage, or null (SSR, privacy modes that throw on access). */
export function browserDraftStorage(): DraftStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeComment(raw: unknown): DraftComment | null {
  if (!isObject(raw)) return null
  const { id, path, body } = raw
  if (typeof id !== "string" || !id || typeof path !== "string" || !path || typeof body !== "string") return null
  const comment: DraftComment = {
    id,
    path,
    body: body.slice(0, MAX_COMMENT_CHARS),
    revision: typeof raw.revision === "string" ? raw.revision : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  }
  if (typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0) {
    comment.line = raw.line
    comment.side = raw.side === "old" ? "old" : "new"
  }
  if (typeof raw.excerpt === "string") comment.excerpt = raw.excerpt.slice(0, MAX_EXCERPT_CHARS)
  return comment
}

/** Never throws: corrupt or foreign values read as "no drafts". */
export function loadDrafts(taskId: string, storage: DraftStorage | null = browserDraftStorage()): ReviewDraftState {
  if (!storage) return EMPTY_DRAFTS
  let raw: string | null
  try {
    raw = storage.getItem(draftStorageKey(taskId))
  } catch {
    return EMPTY_DRAFTS
  }
  if (!raw) return EMPTY_DRAFTS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed) || parsed.v !== 1) return EMPTY_DRAFTS
    const comments = Array.isArray(parsed.comments)
      ? parsed.comments.map(decodeComment).filter((comment): comment is DraftComment => comment !== null).slice(0, MAX_DRAFT_COMMENTS)
      : []
    const message = typeof parsed.message === "string" ? parsed.message.slice(0, MAX_MESSAGE_CHARS) : ""
    return { message, comments }
  } catch {
    return EMPTY_DRAFTS
  }
}

/** Persists (or clears, when empty). Storage failures (quota, privacy mode) are reported, not thrown. */
export function saveDrafts(taskId: string, state: ReviewDraftState, storage: DraftStorage | null = browserDraftStorage()): boolean {
  if (!storage) return false
  const key = draftStorageKey(taskId)
  try {
    if (!state.message.trim() && state.comments.length === 0) {
      storage.removeItem(key)
      return true
    }
    storage.setItem(key, JSON.stringify({ v: 1, message: state.message, comments: state.comments }))
    return true
  } catch {
    return false
  }
}

let idCounter = 0
export function newCommentId(now: number = Date.now()): string {
  idCounter = (idCounter + 1) % 1_000_000
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `c_${now.toString(36)}_${idCounter.toString(36)}_${random}`
}

export interface NewCommentInput {
  path: string
  line?: number
  side?: CommentSide
  body: string
  revision: string | null
  excerpt?: string
}

export type DraftAction =
  | { type: "add"; comment: NewCommentInput; id?: string; now?: number }
  | { type: "edit"; id: string; body: string; now?: number }
  | { type: "remove"; id: string }
  | { type: "message"; message: string }
  | { type: "sent"; commentIds: readonly string[]; clearMessage: boolean }
  | { type: "replace"; state: ReviewDraftState }

/** Reducer for draft edits. Returns the same object when nothing changed. */
export function applyDraftAction(state: ReviewDraftState, action: DraftAction): ReviewDraftState {
  switch (action.type) {
    case "add": {
      const body = action.comment.body.trim().slice(0, MAX_COMMENT_CHARS)
      if (!body || state.comments.length >= MAX_DRAFT_COMMENTS) return state
      const now = action.now ?? Date.now()
      const comment: DraftComment = {
        id: action.id ?? newCommentId(now),
        path: action.comment.path,
        body,
        revision: action.comment.revision,
        createdAt: now,
        updatedAt: now,
      }
      if (action.comment.line !== undefined && action.comment.line > 0) {
        comment.line = action.comment.line
        comment.side = action.comment.side ?? "new"
      }
      if (action.comment.excerpt !== undefined) comment.excerpt = action.comment.excerpt.slice(0, MAX_EXCERPT_CHARS)
      return { ...state, comments: [...state.comments, comment] }
    }
    case "edit": {
      const body = action.body.trim().slice(0, MAX_COMMENT_CHARS)
      const index = state.comments.findIndex((comment) => comment.id === action.id)
      if (index === -1) return state
      if (!body) return { ...state, comments: state.comments.filter((comment) => comment.id !== action.id) }
      const current = state.comments[index]!
      if (current.body === body) return state
      const comments = state.comments.slice()
      comments[index] = { ...current, body, updatedAt: action.now ?? Date.now() }
      return { ...state, comments }
    }
    case "remove": {
      if (!state.comments.some((comment) => comment.id === action.id)) return state
      return { ...state, comments: state.comments.filter((comment) => comment.id !== action.id) }
    }
    case "message": {
      const message = action.message.slice(0, MAX_MESSAGE_CHARS)
      return message === state.message ? state : { ...state, message }
    }
    case "sent": {
      const sent = new Set(action.commentIds)
      const comments = state.comments.filter((comment) => !sent.has(comment.id))
      const message = action.clearMessage ? "" : state.message
      if (comments.length === state.comments.length && message === state.message) return state
      return { message, comments }
    }
    case "replace":
      return action.state
  }
}

/** Composer order: by file path, then line (file-level comments first), then creation. */
export function sortComments(comments: readonly DraftComment[]): DraftComment[] {
  return [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    const lineA = a.line ?? 0
    const lineB = b.line ?? 0
    if (lineA !== lineB) return lineA - lineB
    if ((a.side ?? "") !== (b.side ?? "")) return (a.side ?? "") < (b.side ?? "") ? -1 : 1
    return a.createdAt - b.createdAt
  })
}

export function commentLocation(comment: Pick<DraftComment, "path" | "line" | "side">): string {
  if (comment.line === undefined) return comment.path
  return `${comment.path}:${comment.side === "old" ? "old " : ""}${comment.line}`
}
