import type { Task } from "@/types/task"

/**
 * W17a: whether a board task is still blocked. Blockers on the board are
 * judged by their live status (so marking one done unblocks its dependents
 * at once); blockers not on the board fall back to the server's count.
 * Only open work shows as blocked.
 */
export function isTaskBlocked(
  task: Pick<Task, "status" | "blockedByIds" | "openBlockerCount">,
  lookup: (taskId: string) => Pick<Task, "status"> | undefined,
): boolean {
  if (task.status === "done" || task.status === "cancelled") return false
  const ids = task.blockedByIds ?? []
  if (ids.length === 0) return false
  let unknown = 0
  for (const id of ids) {
    const blocker = lookup(id)
    if (!blocker) unknown += 1
    else if (blocker.status !== "done") return true
  }
  return unknown > 0 && (task.openBlockerCount ?? 0) > 0
}

export function blockedTaskIdsOf(tasks: readonly Task[], tasksById: ReadonlyMap<string, Task>): ReadonlySet<string> {
  const blocked = new Set<string>()
  const lookup = (id: string) => tasksById.get(id)
  for (const task of tasks) if (isTaskBlocked(task, lookup)) blocked.add(task.id)
  return blocked
}

/** "ENG-1, ENG-3" — the open blockers of a task that are on the board (others counted). */
export function blockerSummary(task: Pick<Task, "blockedByIds" | "openBlockerCount">, tasksById: ReadonlyMap<string, Task>): string | null {
  const open = (task.blockedByIds ?? [])
    .map((id) => tasksById.get(id))
    .filter((blocker): blocker is Task => blocker !== undefined && blocker.status !== "done")
  const named = open.map((blocker) => blocker.identifier ?? blocker.title)
  const offBoard = Math.max(0, (task.openBlockerCount ?? 0) - open.length)
  if (named.length === 0 && offBoard === 0) return null
  const parts = named.slice(0, 3)
  const more = named.length - parts.length + offBoard
  return `${parts.join(", ")}${more > 0 ? `${parts.length ? " and " : ""}${more} more` : ""}`
}

const PRIORITY_RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 }

/**
 * "Run ready": open tasks nothing blocks and no execution holds, highest
 * priority first (then oldest), at most `limit` (the user's batch size).
 */
export function readyToRun(tasks: readonly Task[], blocked: ReadonlySet<string>, limit: number): Task[] {
  return tasks
    .filter((task) => (task.status === "todo" || task.status === "in_progress") && !task.archived && !blocked.has(task.id) && !(task.status === "in_progress" && task.sessionId))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, Math.max(0, limit))
}

