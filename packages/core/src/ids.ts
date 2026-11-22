// IDs in the order they were made.
//
// An ID starts with the millisecond it was made in, so IDs of different milliseconds sort by
// time. Those of one millisecond would sort by chance. Here they do not: the first of a
// millisecond takes fresh random bytes, and each one after it in that millisecond is the one
// before plus one. So a list that is in the order of its IDs is in the order things were made,
// however quickly they were.

import { makeId } from '@acentric/protocol';
import type { Id, IdKind } from '@acentric/protocol';

export class IdSource {
  readonly #entropy: () => Uint8Array;
  #last = -1;
  #random: Uint8Array = new Uint8Array(10);

  /** `entropy` gives ten random bytes. */
  constructor(entropy: () => Uint8Array) {
    this.#entropy = entropy;
  }

  /** A new ID of a kind, later than every ID this has made. */
  make<K extends IdKind>(kind: K, now: number): Id<K> {
    if (now > this.#last) {
      this.#last = now;
      this.#random = Uint8Array.from(this.#entropy());
    } else {
      // The same millisecond, or a clock that went back: one more than the last.
      let carried = true;
      for (let index = this.#random.length - 1; index >= 0 && carried; index -= 1) {
        const byte = ((this.#random[index] as number) + 1) & 255;
        this.#random[index] = byte;
        carried = byte === 0;
      }
      // Every byte was at its most: the next millisecond is taken, which is later still.
      if (carried) this.#last += 1;
    }
    return makeId(kind, { now: this.#last, random: this.#random });
  }
}
