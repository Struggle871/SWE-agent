export type InputKind = "shutdown" | "interrupt" | "approval_result" | "manual_compact" | "steer" | "user_input" | "background";

export interface QueuedInput<T> {
  kind: InputKind;
  value: T;
  sequence: number;
}

const priority: Record<InputKind, number> = {
  shutdown: 0,
  interrupt: 0,
  approval_result: 1,
  manual_compact: 2,
  steer: 2,
  user_input: 2,
  background: 3,
};

/** Promise-driven priority queue used at turn boundaries. */
export class InputQueue<T> {
  private readonly entries: QueuedInput<T>[] = [];
  private sequence = 0;
  private waiter: (() => void) | undefined;

  push(kind: InputKind, value: T): void {
    this.entries.push({ kind, value, sequence: this.sequence++ });
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  take(): QueuedInput<T> | undefined {
    if (this.entries.length === 0) return undefined;
    this.entries.sort((a, b) => priority[a.kind] - priority[b.kind] || a.sequence - b.sequence);
    return this.entries.shift();
  }

  async wait(): Promise<QueuedInput<T>> {
    while (true) {
      const next = this.take();
      if (next) return next;
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }

  get size(): number {
    return this.entries.length;
  }
}
