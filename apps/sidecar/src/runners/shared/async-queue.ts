/**
 * Unbounded single-consumer queue. Producers (a process's stdout pump, the
 * cancellation path) push; the session's event iterator pulls. Decoupling
 * the two means a blocked read never delays a cancellation receipt.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T, undefined>) => void> = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** No further items; pending and future reads finish once the buffer drains. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T, undefined>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
