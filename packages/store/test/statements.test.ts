// The statements the store prepares, kept for when they are run again: up to a number.

import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { preparedStatements } from '../src/database.ts';

describe('prepared statements', () => {
  it('are kept up to a number, those run longest ago going first', () => {
    const db = new DatabaseSync(':memory:');
    const statements = preparedStatements(db, 3);
    // As a list of a length of its own makes a statement of its own.
    const listOf = (count: number) =>
      `SELECT 1 WHERE 1 IN (${Array.from({ length: count }, () => '?').join(', ')})`;
    const first = statements.of(listOf(1));
    for (let count = 2; count <= 50; count += 1) {
      statements.of(listOf(count));
      // The first is run often, and is kept.
      expect(statements.of(listOf(1))).toBe(first);
      expect(statements.size).toBeLessThanOrEqual(3);
    }
    expect(Object.values(statements.of(listOf(2)).get(1) ?? {})).toEqual([1]);
    db.close();
  });
});
