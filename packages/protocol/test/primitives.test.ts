import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ERROR_CODES, ERROR_STATUS, errorResponseSchema, statusOf } from '../src/errors.ts';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  pageQuerySchema,
  pageSchema,
  timestampSchema,
} from '../src/primitives.ts';

describe('timestampSchema', () => {
  it('takes whole milliseconds, 0 or more', () => {
    expect(timestampSchema.safeParse(Date.now()).success).toBe(true);
    expect(timestampSchema.safeParse(0).success).toBe(true);
    for (const value of [-1, 1.5, '1795305600000', null]) {
      expect(timestampSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe('pageQuerySchema', () => {
  it('reads a query, whose values are strings', () => {
    expect(pageQuerySchema.parse({ limit: '20', cursor: 'abc' })).toEqual({
      limit: 20,
      cursor: 'abc',
    });
  });

  it('gives the default size when none is asked for', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it('refuses a size out of range, and an empty cursor', () => {
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: 'many' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('pageSchema', () => {
  it('is the items and the next cursor, null on the last page', () => {
    const schema = pageSchema(z.string());
    expect(schema.parse({ items: ['a'], nextCursor: null })).toEqual({
      items: ['a'],
      nextCursor: null,
    });
    expect(schema.safeParse({ items: ['a'] }).success).toBe(false);
  });
});

describe('errors', () => {
  it('answers every code with a client or server error status', () => {
    for (const code of ERROR_CODES) {
      expect(statusOf(code), code).toBe(ERROR_STATUS[code]);
      expect(statusOf(code), code).toBeGreaterThanOrEqual(400);
      expect(statusOf(code), code).toBeLessThan(600);
    }
  });

  it('takes the envelope, and refuses a code that is not in the list', () => {
    const failed = { error: { code: 'not_found', message: 'There is no such actor' } };
    expect(errorResponseSchema.parse(failed)).toEqual(failed);
    expect(errorResponseSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(
      false,
    );
  });
});
