import { describe, expect, it } from 'vitest';

import { ID_PREFIXES, idSchema, isId, makeId, parseId } from '../src/ids.ts';
import type { ActorId, AgentId, IdKind } from '../src/ids.ts';

const random = (fill: number): Uint8Array => new Uint8Array(10).fill(fill);

describe('makeId', () => {
  it('makes an ID of its kind: the prefix, then 26 characters', () => {
    const id = makeId('actor', { now: 1_795_305_600_000, random: random(0xab) });
    expect(id).toMatch(/^act_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    expect(isId('actor', id)).toBe(true);
    expect(isId('agent', id)).toBe(false);
  });

  it('gives the same ID for the same time and bytes', () => {
    const source = { now: 1_795_305_600_000, random: random(7) };
    expect(makeId('key', source)).toBe(makeId('key', source));
  });

  it('is a UUID of version 7 inside', () => {
    const id = makeId('agent', { now: 0x0123_4567_89ab, random: random(0xff) });
    let bits = 0n;
    for (const character of id.slice(4)) {
      bits = (bits << 5n) | BigInt('0123456789abcdefghjkmnpqrstvwxyz'.indexOf(character));
    }
    const hex = bits.toString(16).padStart(32, '0');
    expect(hex.slice(0, 12)).toBe('0123456789ab');
    // The version, then the variant: 7, and one of 8, 9, a, b.
    expect(hex[12]).toBe('7');
    expect(hex[16]).toBe('b');
    // Every random bit that has a place was kept.
    expect(hex.slice(13, 16)).toBe('fff');
    expect(hex.slice(17)).toBe('f'.repeat(15));
  });

  it('sorts by the time it was made', () => {
    const earlier = makeId('input', { now: 1000, random: random(0xff) });
    const later = makeId('input', { now: 1001, random: random(0) });
    expect(earlier < later).toBe(true);
  });

  it('refuses a time that is not one, and too few bytes', () => {
    expect(() => makeId('actor', { now: -1, random: random(0) })).toThrow(RangeError);
    expect(() => makeId('actor', { now: 1.5, random: random(0) })).toThrow(RangeError);
    expect(() => makeId('actor', { now: 2 ** 48, random: random(0) })).toThrow(RangeError);
    expect(() => makeId('actor', { now: 0, random: new Uint8Array(9) })).toThrow(RangeError);
  });
});

describe('parseId', () => {
  it('gives the kind and the time of every kind of ID', () => {
    for (const kind of Object.keys(ID_PREFIXES) as IdKind[]) {
      const id = makeId(kind, { now: 1_795_305_600_123, random: random(0x5a) });
      expect(parseId(id)).toEqual({ kind, createdAt: 1_795_305_600_123 });
    }
  });

  it('gives undefined for what is not an ID', () => {
    for (const value of [
      '',
      'support',
      'act_',
      'act_01jd3m5kq8f4xv9t6w2rhb0c7', // 25 characters
      'act_81jd3m5kq8f4xv9t6w2rhb0c7n', // more than 128 bits
      'act_01jd3m5kq8f4xv9t6w2rhb0c7l', // l is not in the alphabet
      'ACT_01jd3m5kq8f4xv9t6w2rhb0c7n',
      'xyz_01jd3m5kq8f4xv9t6w2rhb0c7n',
    ]) {
      expect(parseId(value), value).toBeUndefined();
    }
  });
});

describe('idSchema', () => {
  it('takes an ID of its kind and no other', () => {
    const schema = idSchema('actor');
    const actor = makeId('actor', { now: 5, random: random(1) });
    expect(schema.parse(actor)).toBe(actor);
    expect(schema.safeParse(makeId('agent', { now: 5, random: random(1) })).success).toBe(false);
    expect(schema.safeParse('support').success).toBe(false);
    expect(schema.safeParse(5).success).toBe(false);
  });

  it('keeps the kinds apart in the types', () => {
    const actor: ActorId = makeId('actor', { now: 5, random: random(1) });
    // @ts-expect-error An actor's ID is not an agent's.
    const agent: AgentId = actor;
    expect(agent).toBe(actor);
  });
});
