import { describe, expect, it } from 'vitest';

import type { MachineId } from '@acentric/protocol';

import { renderCommand } from '../src/bash.ts';
import { familyOf } from '../src/families.ts';
import type { CommandEnd } from '../src/machines.ts';
import { instructionsOf, scaffoldOf } from '../src/scaffold.ts';

const ended = (more: Partial<CommandEnd> = {}): CommandEnd => ({
  actor: 'act_1',
  task: 'b1',
  machine: 'mch_1' as MachineId,
  command: 'make',
  cwd: '~',
  timeout: null,
  status: 'exited',
  stopWanted: false,
  exit: 0,
  stoppedBy: null,
  ranMs: 2300,
  bytes: 3,
  lines: 1,
  tail: 'hi\n',
  log: '/tasks/act_1/b1/output.log',
  error: null,
  startedAt: 0,
  endedAt: 2300,
  ...more,
});

describe('how a command ending reads', () => {
  it('is what it wrote, and nothing else when it ended well', () => {
    expect(renderCommand(ended(), '~/log', 100)).toBe('hi');
    expect(renderCommand(ended({ tail: 'no newline', bytes: 10 }), '~/log', 100)).toBe(
      'no newline',
    );
    expect(renderCommand(ended({ tail: '', bytes: 0, lines: 0 }), '~/log', 100)).toBe(
      '(no output)',
    );
  });

  it('is cut to its end at the start of a line, and says of how much, and where all of it is', () => {
    const tail = 'one\ntwo\nthree\nfour\n';
    const cut = renderCommand(ended({ tail, bytes: tail.length, lines: 4 }), '~/log', 12);
    // From the middle of `two`: that line is left out.
    expect(cut).toBe('three\nfour\n[showing the last 2 lines of 4 · all of it: ~/log]');
    // Cut exactly at a line's start, the line is kept whole.
    const even = renderCommand(ended({ tail, bytes: tail.length, lines: 4 }), '~/log', 11);
    expect(even).toBe('three\nfour\n[showing the last 2 lines of 4 · all of it: ~/log]');
    // The machine kept only the end: its first line is from the middle of one.
    const kept = renderCommand(
      ended({ tail: 'lf\nwhole\n', bytes: 5000, lines: 1200 }),
      undefined,
      100,
    );
    expect(kept).toBe('whole\n[showing the last 1 lines of 1,200]');
  });

  it('keeps one long line that is all there is, and counts it as one', () => {
    const line = 'x'.repeat(50);
    expect(renderCommand(ended({ tail: line, bytes: 50, lines: 1 }), '~/log', 20)).toBe(
      `${'x'.repeat(20)}\n[showing the last 1 lines of 1 · all of it: ~/log]`,
    );
  });

  it('says each way of ending in a line of its own, after the output', () => {
    expect(renderCommand(ended({ exit: 1 }), undefined, 100)).toBe('hi\n[exit 1 · 2s]');
    expect(renderCommand(ended({ exit: null, tail: '', bytes: 0 }), undefined, 100)).toBe(
      '[exit unknown · 2s]',
    );
    // Why it was stopped is the engine's to say.
    expect(renderCommand(ended({ status: 'stopped', stoppedBy: 'timeout' }), undefined, 100)).toBe(
      'hi',
    );
    expect(renderCommand(ended({ status: 'stopped', stoppedBy: 'output' }), undefined, 100)).toBe(
      'hi\n[stopped by the machine after 2s: it wrote more than the machine keeps of one command]',
    );
    expect(
      renderCommand(ended({ status: 'lost', error: 'Its machine was removed' }), undefined, 100),
    ).toBe('hi\nIts machine was removed');
    expect(
      renderCommand(
        ended({ status: 'failed', tail: null, bytes: null, error: null }),
        undefined,
        9,
      ),
    ).toBe('It is gone');
  });
});

describe('the pieces of the scaffold', () => {
  const none = { tools: [], machine: null };
  const onMachine = {
    tools: ['bash', 'stop'],
    machine: { cwd: '~/work', os: 'darwin', arch: 'arm64' },
  };
  const headings = (text: string): string[] =>
    text.split('\n').filter((line) => line.startsWith('# '));

  it('are one for every actor, and one more for each thing an actor has', () => {
    expect(headings(scaffoldOf(none))).toEqual(['# How you work here']);
    expect(headings(scaffoldOf(onMachine))).toEqual([
      '# How you work here',
      '# Tasks',
      '# Your machine',
    ]);
    // The tool without the machine, or the machine without the tool, is no machine to tell of.
    expect(headings(scaffoldOf({ ...onMachine, machine: null }))).toEqual(['# How you work here']);
    expect(headings(scaffoldOf({ ...onMachine, tools: ['stop'] }))).toEqual([
      '# How you work here',
    ]);
  });

  it('say of a notice that it is the harness’s, in the tag the engine sends them in', () => {
    expect(scaffoldOf(none)).toContain(
      'Text inside <system-notice> tags comes from the harness, not from a person',
    );
  });

  it('say where the machine is, as far as it is known, and of a tool only to a model that has it', () => {
    expect(scaffoldOf(onMachine)).toContain(
      'It runs macOS (arm64), and your working directory is ~/work.',
    );
    const unknown = { ...onMachine, machine: { cwd: '/srv', os: null, arch: null } };
    expect(scaffoldOf(unknown)).toContain(
      '`bash` runs commands on your machine. Your working directory is /srv.',
    );
    const other = { ...onMachine, machine: { cwd: '/srv', os: 'freebsd', arch: null } };
    expect(scaffoldOf(other)).toContain('It runs freebsd, and your working directory is /srv.');

    expect(scaffoldOf(onMachine)).not.toContain('view_image');
    expect(scaffoldOf({ ...onMachine, tools: ['bash', 'stop', 'view_image'] })).toContain(
      '- `view_image` shows you an image file from the machine.',
    );
    expect(scaffoldOf(onMachine)).not.toContain('`schedule`');
    expect(scaffoldOf({ ...onMachine, tools: ['bash', 'stop', 'schedule'] })).toContain(
      '- `schedule` sends you a note later',
    );
  });

  it('add a line for a family where its models need one, and only there', () => {
    const line = 'before it is stopped. Leave it empty for long work.';
    expect(scaffoldOf({ ...onMachine, family: 'gpt' })).toContain(line);
    expect(scaffoldOf({ ...onMachine, family: 'claude' })).not.toContain('Leave it empty');
    expect(scaffoldOf(onMachine)).not.toContain('Leave it empty');
    expect(familyOf('gpt-5.5')).toBe('gpt');
    expect(familyOf('accounts/fireworks/models/kimi-k2')).toBe('kimi');
    expect(familyOf('Claude-Opus-5')).toBe('claude');
    expect(familyOf('glm-5')).toBe('glm');
    expect(familyOf('deepseek-v4')).toBe('deepseek');
    expect(familyOf('fake-1')).toBeUndefined();
  });

  it('are followed by the agent’s own instructions, when it has any', () => {
    expect(instructionsOf(none, 'You answer.')).toBe(`${scaffoldOf(none)}\n\nYou answer.`);
    expect(instructionsOf(none, '  \n')).toBe(scaffoldOf(none));
  });
});
