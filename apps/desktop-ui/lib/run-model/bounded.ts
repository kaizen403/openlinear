/**
 * A Set that forgets its oldest members past `capacity` (insertion order).
 * O(1) add/has; used for dedupe memory so an hours-long run can't grow it
 * without bound.
 */
export class BoundedSet<T> {
  private readonly items = new Set<T>()

  constructor(private readonly capacity: number) {}

  has(value: T): boolean {
    return this.items.has(value)
  }

  /** Adds `value`; returns false when it was already present. */
  add(value: T): boolean {
    if (this.items.has(value)) return false
    this.items.add(value)
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next()
      if (!oldest.done) this.items.delete(oldest.value)
    }
    return true
  }

  get size(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }
}

/** Cut `text` to `max` characters; reports whether anything was removed. */
export function clampText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

/** Keep the tail of streamed output (the most recent lines matter most). */
export function clampTail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `…${text.slice(text.length - Math.max(0, max - 1))}`, truncated: true }
}
