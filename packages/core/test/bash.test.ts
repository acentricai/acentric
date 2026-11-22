import { describe, expect, it } from 'vitest';

import type { MachineId } from '@acentric/protocol';

import { renderCommand } from '../src/bash.ts';
import { familyOf } from '../src/families.ts';
import type { CommandEnd } from '../src/machines.ts';
import { instructionsOf, scaffoldOf } from '../src/scaffold.ts';
import { imageSize, imageTypeOf, viewImage } from '../src/view-image.ts';

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

describe('an image file', () => {
  const png = (width: number, height: number): Buffer => {
    const bytes = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00, 0, 0])]);
  // A JPEG of 640 by 480, with a segment before its frame header.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02,
    0x80, 0x03, 0x01, 0x11, 0x00,
  ]);
  const webp = (kind: string, rest: number[]): Buffer =>
    Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.from(kind),
      Buffer.from(rest),
      Buffer.alloc(16),
    ]);

  it('is known by how it starts, whatever it is called', () => {
    expect(imageTypeOf(png(1, 1))).toBe('image/png');
    expect(imageTypeOf(gif)).toBe('image/gif');
    expect(imageTypeOf(jpeg)).toBe('image/jpeg');
    expect(imageTypeOf(webp('VP8X', []))).toBe('image/webp');
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(imageTypeOf(Buffer.from('RIFF....WAVE'))).toBeUndefined();
    expect(imageTypeOf(Buffer.alloc(0))).toBeUndefined();
  });

  it('says how large it is, from where each kind keeps that', () => {
    expect(imageSize(png(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 });
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
    // 4 bytes of size and 4 of flags, then the width and the height less one, 3 bytes each.
    expect(imageSize(webp('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x03, 0, 0xff, 0x01, 0]))).toEqual(
      { width: 1024, height: 512 },
    );
    expect(imageSize(Buffer.from('not an image'))).toBeUndefined();
    expect(imageSize(png(1, 1).subarray(0, 12))).toBeUndefined();
  });

  it('is kept from a model whose provider takes none so large, and it is told how to look at it', async () => {
    const actor = { machine: { id: 'mch_1', cwd: '~', env: [] } } as never;
    const machines = (image: Buffer) =>
      ({
        settled: async () => {},
        read: async () => ({ size: image.length, from: 0, data: image.toString('base64') }),
      }) as never;
    const shown = (image: Buffer, provider: string) =>
      viewImage(machines(image), () => true).run(
        actor,
        { provider } as never,
        { path: 'big.png' },
        { id: 'c1' },
      );
    expect(await shown(png(4000, 300), 'anthropic')).toEqual({
      content:
        'big.png is 4000×300 pixels, and the largest image this model can be shown is 3000 pixels a side. Make a smaller copy, and look at that.',
      isError: true,
    });
    expect(await shown(png(3000, 3000), 'anthropic')).toMatchObject({
      content: [{ type: 'image' }],
    });
    // A provider that scales a large image down itself is given it as it is.
    expect(await shown(png(4000, 300), 'openai')).toMatchObject({ content: [{ type: 'image' }] });
  });
});
