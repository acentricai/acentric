// How many of something go on at once.

/** So many holders at once. One that asks when all are taken waits its turn, in the order asked. */
export class Semaphore {
  readonly size: number;
  #free: number;
  #waiting: ((held: boolean) => void)[] = [];
  #closed = false;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`A limit is a whole number, 1 or more: got ${String(size)}`);
    }
    this.size = size;
    this.#free = size;
  }

  /** How many are held now. */
  get held(): number {
    return this.size - this.#free;
  }

  /** How many wait for one. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** Resolves with true once one is held, or with false when it was closed: nothing is held then. */
  acquire(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#free += 1;
    else next(true);
  }

  /** Gives no more: whoever waits, and whoever asks from now on, is told so. */
  close(): void {
    this.#closed = true;
    for (const waiting of this.#waiting.splice(0)) waiting(false);
  }
}
