import { describe, expect, it } from 'vitest';

import { makeId } from '../src/ids.ts';
import { externalIdSchema, labelSchema, nameSchema } from '../src/names.ts';

describe('nameSchema', () => {
  it('takes lowercase names of letters, digits, - and _', () => {
    for (const name of ['support', 'brain-health', 'a', '9lives', 'review_v2', 'a'.repeat(63)]) {
      expect(nameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('refuses what is not such a name', () => {
    for (const name of [
      '',
      'Support',
      '-support',
      '_support',
      'two words',
      'café',
      'a'.repeat(64),
      'a/b',
    ]) {
      expect(nameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('refuses a name that has the form of an ID', () => {
    const id = makeId('actor', { now: 5, random: new Uint8Array(10) });
    expect(nameSchema.safeParse(id).success).toBe(false);
    // Only the form of an ID is refused: a prefix alone is an ordinary name.
    expect(nameSchema.safeParse('act_support').success).toBe(true);
  });
});

describe('externalIdSchema', () => {
  it("takes what a caller's system would call a thing", () => {
    for (const id of ['4411', 'telegram:4411', 'Order #12 / EU', 'ü', 'a'.repeat(256)]) {
      expect(externalIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it('refuses the empty, the too long, and control characters', () => {
    for (const id of ['', 'a'.repeat(257), 'line\nbreak', 'tab\there', 'nul\u0000']) {
      expect(externalIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe('labelSchema', () => {
  it('trims, and refuses what is then empty', () => {
    expect(labelSchema.parse('  the CI key ')).toBe('the CI key');
    expect(labelSchema.safeParse('   ').success).toBe(false);
  });
});
