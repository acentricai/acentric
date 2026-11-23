// An agent whose actors work on a machine, and whose code reads and writes the files there.

import { Agent } from '@acentric/agent';
import { z } from 'zod';

export default new Agent({
  provider: 'fake',
  instructions: 'You keep files.',
  machine: true,
  tools: [
    {
      name: 'save',
      description: 'Saves text to a file.',
      parameters: z.object({ path: z.string(), text: z.string() }),
      execute: async ({ path, text }, { machine }) => {
        await machine.write(path, text);
        return `saved ${path}`;
      },
    },
    {
      name: 'load',
      description: 'Reads a file as text.',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }, { machine }) => machine.readText(path),
    },
    {
      name: 'big',
      description: 'Writes a file of this many bytes, and reads it back.',
      parameters: z.object({ bytes: z.number() }),
      execute: async ({ bytes }, { machine }) => {
        const data = new Uint8Array(bytes).map((_, i) => i % 251);
        await machine.write('big.bin', data);
        const back = await machine.read('big.bin');
        return `${String(back.length)} ${String(back.every((byte, i) => byte === i % 251))}`;
      },
    },
    {
      name: 'what',
      description: 'Says what its machine is, as data.',
      parameters: z.object({}),
      execute: (_args, { machine }) =>
        JSON.stringify({
          keys: Object.keys(machine),
          spread: { ...machine },
          json: JSON.parse(JSON.stringify(machine)) as unknown,
        }),
    },
  ],
  // A note it sent itself is put down where it works, and comes with where that was.
  schedule: {
    handler: async ({ note, dueAt }, { machine }) => {
      await machine.write('notes/due.txt', `${note} (due ${dueAt.toISOString()})`);
      return `${note}\nIt is in notes/due.txt.`;
    },
  },
  inputs: {
    upload: {
      schema: z.object({ name: z.string(), base64: z.string() }),
      handler: async ({ name, base64 }, { machine }) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        await machine.write(`inbox/${name}`, bytes);
        const size = (await machine.read(`inbox/${name}`)).length;
        return `A file is in inbox/${name}: ${String(size)} bytes.`;
      },
    },
  },
});
