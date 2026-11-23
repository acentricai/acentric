// The server's log: a line for a person, or an object to a line for what collects it, with the
// same fields, from the level it is given.

import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/log.ts';
import type { Format, Level } from '../src/log.ts';

const AT = Date.parse('2026-11-23T12:00:00.000Z');
const logged = (format: Format, level: Level = 'info') => {
  const lines: { line: string; level: Level }[] = [];
  const logger = createLogger({
    format,
    level,
    clock: () => AT,
    write: (line, at) => lines.push({ line, level: at }),
  });
  return { logger, lines };
};

describe('the server’s log', () => {
  it('as text: what it says, then its fields, quoted where they need to be', () => {
    const { logger, lines } = logged('text');
    logger.info('acentric-server 0.15.0 listening on http://127.0.0.1:4000');
    logger.child({ requestId: 'r1' }).info('request', {
      method: 'GET',
      route: 'actors.get',
      status: 200,
      ms: 12,
      by: undefined,
      note: 'two words',
    });
    logger.warn('turn ended', { end: 'failed', reason: 'The model failed' });
    expect(lines.map(({ line }) => line)).toEqual([
      'acentric-server 0.15.0 listening on http://127.0.0.1:4000',
      'request requestId=r1 method=GET route=actors.get status=200 ms=12 note="two words"',
      'warn: turn ended end=failed reason="The model failed"',
    ]);
    // Warnings and errors are told apart, for stderr.
    expect(lines.map(({ level }) => level)).toEqual(['info', 'info', 'warn']);
  });

  it('as JSON: an object to a line, with when, how bad, and the same fields', () => {
    const { logger, lines } = logged('json');
    logger.child({ actor: 'act_1' }).info('turn ended', { end: 'ok', ms: 1200, reason: undefined });
    expect(lines.map(({ line }) => JSON.parse(line) as unknown)).toEqual([
      {
        time: '2026-11-23T12:00:00.000Z',
        level: 'info',
        msg: 'turn ended',
        actor: 'act_1',
        end: 'ok',
        ms: 1200,
      },
    ]);
  });

  it('says what an error was, and where, under the line or in it', () => {
    const error = new RangeError('The order is out of range');
    const text = logged('text');
    text.logger.error('the engine failed at something', { actor: 'act_1' }, error);
    const [line = ''] = text.lines.map(({ line: written }) => written);
    expect(line.split('\n')[0]).toBe(
      'error: the engine failed at something: RangeError: The order is out of range actor=act_1',
    );
    expect(line.split('\n')[1]).toMatch(/^\s+at /);

    const json = logged('json');
    json.logger.error('the engine failed at something', {}, error);
    expect(JSON.parse(json.lines[0]?.line ?? '{}')).toMatchObject({
      level: 'error',
      error: 'RangeError: The order is out of range',
      stack: expect.stringContaining('RangeError: The order is out of range'),
    });
  });

  it('writes nothing below its level', () => {
    const { logger, lines } = logged('text', 'warn');
    logger.debug('model called');
    logger.info('request');
    logger.warn('model call failed');
    logger.error('the audit log could not be written to');
    expect(lines.map(({ line }) => line)).toEqual([
      'warn: model call failed',
      'error: the audit log could not be written to',
    ]);
    const quiet = logged('text');
    quiet.logger.debug('tool called');
    expect(quiet.lines).toEqual([]);
  });
});
