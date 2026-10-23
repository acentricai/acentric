// Every session's `@timer` effects in one scheduler: due times kept in
// order, with one Node timer armed for the earliest. Node timers wait at
// most about 24.8 days, so a later due time is reached in steps.

const LONGEST = 2 ** 31 - 1;

type Due = { id: string; at: number; fire: () => void };

export class Scheduler {
  readonly #clock: () => number;
  #due: Due[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  /** Calls `fire` at `at`. `id` names the timer, so it can be removed. */
  add(id: string, at: number, fire: () => void): void {
    this.remove(id);
    const index = this.#due.findIndex((due) => due.at > at);
    const entry = { id, at, fire };
    if (index === -1) this.#due.push(entry);
    else this.#due.splice(index, 0, entry);
    this.#arm();
  }

  remove(id: string): void {
    const before = this.#due.length;
    this.#due = this.#due.filter((due) => due.id !== id);
    if (this.#due.length !== before) this.#arm();
  }

  clear(): void {
    this.#due = [];
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const first = this.#due[0];
    if (first === undefined) return;
    const wait = Math.min(Math.max(0, first.at - this.#clock()), LONGEST);
    this.#timer = setTimeout(() => this.#fire(), wait);
  }

  #fire(): void {
    this.#timer = null;
    const now = this.#clock();
    const ready = this.#due.filter((due) => due.at <= now);
    this.#due = this.#due.filter((due) => due.at > now);
    for (const due of ready) due.fire();
    this.#arm();
  }
}
