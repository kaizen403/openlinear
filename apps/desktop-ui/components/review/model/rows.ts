import type { DiffFile, DiffHunk, DiffLine } from "@/lib/api/review"
import type { CommentSide, DraftComment } from "./drafts"

/**
 * Flattens a diff into the rows the virtualized viewer renders: file headers,
 * hunk headers, line rows (unified) or paired rows (split), notices (binary,
 * truncated, empty) and inline comment threads. Pure and O(lines); rebuilt
 * only when the diff revision, view mode, collapsed set, drafts or the open
 * editor change.
 */

export type ViewMode = "unified" | "split"

/** Where a comment points: one side of one line of one file. */
export interface LineAnchor {
  path: string
  side: CommentSide
  line: number
}

/** The open comment editor: a line anchor, or a whole file when `line` is absent. */
export interface CommentTarget {
  path: string
  side?: CommentSide
  line?: number
}

export type DiffRow =
  | { kind: "file"; key: string; fileIndex: number; file: DiffFile; collapsed: boolean; comments: number }
  | { kind: "hunk"; key: string; fileIndex: number; hunkIndex: number; ordinal: number; hunkCount: number; hunk: DiffHunk; path: string }
  | { kind: "line"; key: string; fileIndex: number; hunkIndex: number; path: string; line: DiffLine; anchor: LineAnchor | null }
  | {
      kind: "pair"
      key: string
      fileIndex: number
      hunkIndex: number
      path: string
      left: DiffLine | null
      right: DiffLine | null
      leftAnchor: LineAnchor | null
      rightAnchor: LineAnchor | null
    }
  | { kind: "notice"; key: string; fileIndex: number; tone: "info" | "warning"; text: string }
  | {
      kind: "thread"
      key: string
      fileIndex: number
      path: string
      target: CommentTarget
      comments: DraftComment[]
      editing: boolean
      /** Comments whose line is no longer part of this diff. */
      orphaned: boolean
    }

export interface DiffRowModel {
  rows: DiffRow[]
  /** Row index of each file header, in file order. */
  fileStarts: number[]
  /** Row index of every hunk header, in order. */
  hunkStarts: number[]
  /** Diff lines represented (unified line count). */
  lineCount: number
}

export interface BuildRowsInput {
  files: readonly DiffFile[]
  mode: ViewMode
  collapsed?: ReadonlySet<string>
  comments?: readonly DraftComment[]
  editing?: CommentTarget | null
}

export function anchorKey(side: CommentSide, line: number): string {
  return `${side}:${line}`
}

/** The comment anchor of a unified line: removed lines point at the old side. */
export function lineAnchor(path: string, line: DiffLine): LineAnchor | null {
  if (line.kind === "del") return line.oldNo !== undefined ? { path, side: "old", line: line.oldNo } : null
  return line.newNo !== undefined ? { path, side: "new", line: line.newNo } : null
}

export function sameTarget(a: CommentTarget | null | undefined, b: CommentTarget | null | undefined): boolean {
  if (!a || !b) return false
  return a.path === b.path && (a.line ?? null) === (b.line ?? null) && (a.line === undefined || (a.side ?? "new") === (b.side ?? "new"))
}

interface FileComments {
  fileLevel: DraftComment[]
  byAnchor: Map<string, DraftComment[]>
  total: number
}

function indexComments(comments: readonly DraftComment[]): Map<string, FileComments> {
  const index = new Map<string, FileComments>()
  for (const comment of comments) {
    let entry = index.get(comment.path)
    if (!entry) {
      entry = { fileLevel: [], byAnchor: new Map(), total: 0 }
      index.set(comment.path, entry)
    }
    entry.total += 1
    if (comment.line === undefined) {
      entry.fileLevel.push(comment)
      continue
    }
    const key = anchorKey(comment.side ?? "new", comment.line)
    const list = entry.byAnchor.get(key)
    if (list) list.push(comment)
    else entry.byAnchor.set(key, [comment])
  }
  return index
}

/** Split view: context lines pair with themselves; a run of removals pairs index-wise with the following run of additions. */
export function pairHunkLines(lines: readonly DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.kind === "context") {
      pairs.push({ left: line, right: line })
      index += 1
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (index < lines.length && lines[index]!.kind === "del") dels.push(lines[index++]!)
    while (index < lines.length && lines[index]!.kind === "add") adds.push(lines[index++]!)
    const length = Math.max(dels.length, adds.length)
    for (let i = 0; i < length; i++) pairs.push({ left: dels[i] ?? null, right: adds[i] ?? null })
  }
  return pairs
}

function emptyFileNotice(file: DiffFile): string {
  if (file.status === "binary") {
    return file.oldPath ? `Binary file renamed from ${file.oldPath} — contents not shown.` : "Binary file — contents not shown."
  }
  if (file.status === "renamed") return file.oldPath ? `Renamed from ${file.oldPath} without content changes.` : "Renamed without content changes."
  if (file.status === "added") return "Empty file."
  if (file.status === "deleted") return "Empty file deleted."
  return file.truncated ? "This file's changes were not shown: the diff reached its size limit." : "No content changes (mode or metadata only)."
}

export function buildDiffRows({ files, mode, collapsed, comments = [], editing = null }: BuildRowsInput): DiffRowModel {
  const rows: DiffRow[] = []
  const fileStarts: number[] = []
  const hunkStarts: number[] = []
  const commentIndex = indexComments(comments)
  let lineCount = 0

  const pushThread = (fileIndex: number, path: string, target: CommentTarget, list: DraftComment[], orphaned = false) => {
    const editingHere = !orphaned && sameTarget(editing, target)
    if (list.length === 0 && !editingHere) return
    const where = target.line === undefined ? "file" : anchorKey(target.side ?? "new", target.line)
    rows.push({
      kind: "thread",
      key: `t:${path}:${orphaned ? "orphaned" : where}`,
      fileIndex,
      path,
      target,
      comments: list,
      editing: editingHere,
      orphaned,
    })
  }

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]!
    const path = file.path
    const fileComments = commentIndex.get(path)
    const isCollapsed = collapsed?.has(path) ?? false
    fileStarts.push(rows.length)
    rows.push({ kind: "file", key: `f:${path}`, fileIndex, file, collapsed: isCollapsed, comments: fileComments?.total ?? 0 })
    if (isCollapsed) continue

    pushThread(fileIndex, path, { path }, fileComments?.fileLevel ?? [])

    if (file.hunks.length === 0) {
      rows.push({ kind: "notice", key: `n:${path}:empty`, fileIndex, tone: file.truncated ? "warning" : "info", text: emptyFileNotice(file) })
    }

    const seenAnchors = new Set<string>()
    const threadAt = (anchor: LineAnchor | null) => {
      if (!anchor) return
      const key = anchorKey(anchor.side, anchor.line)
      if (seenAnchors.has(key)) return
      seenAnchors.add(key)
      pushThread(fileIndex, path, anchor, fileComments?.byAnchor.get(key) ?? [])
    }

    const hunkCount = file.hunks.length
    for (let hunkIndex = 0; hunkIndex < hunkCount; hunkIndex++) {
      const hunk = file.hunks[hunkIndex]!
      hunkStarts.push(rows.length)
      rows.push({ kind: "hunk", key: `h:${path}:${hunkIndex}`, fileIndex, hunkIndex, ordinal: hunkIndex + 1, hunkCount, hunk, path })
      lineCount += hunk.lines.length

      if (mode === "unified") {
        for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex++) {
          const line = hunk.lines[lineIndex]!
          const anchor = lineAnchor(path, line)
          rows.push({ kind: "line", key: `l:${path}:${hunkIndex}:${lineIndex}`, fileIndex, hunkIndex, path, line, anchor })
          threadAt(anchor)
        }
        continue
      }

      const pairs = pairHunkLines(hunk.lines)
      for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
        const { left, right } = pairs[pairIndex]!
        const rightAnchor = right && right.newNo !== undefined ? { path, side: "new" as const, line: right.newNo } : null
        // A context line shows on both sides but is one line: both halves
        // anchor to its new side, exactly like the unified view.
        const context = left !== null && left === right
        const leftAnchor = context ? rightAnchor : left && left.oldNo !== undefined ? { path, side: "old" as const, line: left.oldNo } : null
        rows.push({ kind: "pair", key: `p:${path}:${hunkIndex}:${pairIndex}`, fileIndex, hunkIndex, path, left, right, leftAnchor, rightAnchor })
        if (!context) threadAt(leftAnchor)
        threadAt(rightAnchor)
      }
    }

    if (file.truncated && file.hunks.length > 0) {
      rows.push({
        kind: "notice",
        key: `n:${path}:truncated`,
        fileIndex,
        tone: "warning",
        text: `This file's diff was cut short. In total: ${file.additions} added and ${file.deletions} removed lines.`,
      })
    }

    if (fileComments) {
      const orphans: DraftComment[] = []
      for (const [key, list] of fileComments.byAnchor) if (!seenAnchors.has(key)) orphans.push(...list)
      if (orphans.length > 0) pushThread(fileIndex, path, { path }, orphans, true)
    }
  }

  return { rows, fileStarts, hunkStarts, lineCount }
}

/** Index of the file header at or before `rowIndex`'s file, or -1. */
export function fileIndexOfRow(model: DiffRowModel, rowIndex: number): number {
  const row = model.rows[rowIndex]
  return row ? row.fileIndex : -1
}

/** j/k: the next/previous file header relative to the active row. */
export function adjacentFileStart(model: DiffRowModel, rowIndex: number, direction: 1 | -1): number | null {
  const { fileStarts } = model
  if (fileStarts.length === 0) return null
  const current = fileIndexOfRow(model, rowIndex)
  if (current < 0) return fileStarts[direction === 1 ? 0 : fileStarts.length - 1] ?? null
  if (direction === -1 && rowIndex > (fileStarts[current] ?? 0)) return fileStarts[current] ?? null
  const target = current + direction
  return target >= 0 && target < fileStarts.length ? fileStarts[target]! : null
}

/** n/p: the next/previous hunk header strictly after/before the active row. */
export function adjacentHunkStart(model: DiffRowModel, rowIndex: number, direction: 1 | -1): number | null {
  const { hunkStarts } = model
  if (hunkStarts.length === 0) return null
  // Binary search for the first hunk start > rowIndex.
  let low = 0
  let high = hunkStarts.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (hunkStarts[mid]! <= rowIndex) low = mid + 1
    else high = mid
  }
  if (direction === 1) return low < hunkStarts.length ? hunkStarts[low]! : null
  const before = hunkStarts[low - 1] === rowIndex ? low - 2 : low - 1
  return before >= 0 ? hunkStarts[before]! : null
}

/** The comment target for keyboard `c` on a row (split rows prefer the new side). */
export function commentTargetOfRow(row: DiffRow | undefined): CommentTarget | null {
  if (!row) return null
  if (row.kind === "line") return row.anchor
  if (row.kind === "pair") return row.rightAnchor ?? row.leftAnchor
  if (row.kind === "file") return { path: row.file.path }
  if (row.kind === "thread") return row.target
  return null
}

/** The anchored line's text, for the draft's excerpt. */
export function lineTextAt(file: DiffFile | undefined, target: CommentTarget): string | undefined {
  if (!file || target.line === undefined) return undefined
  const side = target.side ?? "new"
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === "new" && line.kind !== "del" && line.newNo === target.line) return line.text
      if (side === "old" && line.kind !== "add" && line.oldNo === target.line) return line.text
    }
  }
  return undefined
}
