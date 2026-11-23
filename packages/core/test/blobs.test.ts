import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeId } from '@acentric/protocol';
import type { Actor, AgentId, ContentPart, Message } from '@acentric/protocol';

import { BlobMissing, Blobs, MemoryBlobStore, UnknownBlob } from '../src/blobs.ts';
import type { BlobStore } from '../src/blobs.ts';
import { MemoryStore } from '../src/memory-store.ts';

const NOW = 1_795_305_600_000;
const BY = { type: 'system' } as const;

/** Bytes that are no text, and what they are in base64 and by name. */
const picture = (fill: number, length = 300) => {
  const bytes = new Uint8Array(length).fill(fill);
  return {
    bytes,
    data: Buffer.from(bytes).toString('base64'),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
};
const image = (data: string, mediaType = 'image/png'): ContentPart => ({
  type: 'image',
  source: { type: 'base64', mediaType, data },
});

function world(given: { readonly bytes?: BlobStore | null } = {}) {
  const store = new MemoryStore();
  const bytes = given.bytes === undefined ? new MemoryBlobStore() : given.bytes;
  const blobs = new Blobs({ store, clock: () => NOW, ...(bytes === null ? {} : { bytes }) });
  let made = 0;
  const id = <K extends 'agent' | 'deployment' | 'actor'>(kind: K) => {
    made += 1;
    return makeId(kind, { now: NOW, random: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, made]) });
  };
  /** An agent that is there, so that it can be deleted with its actors. */
  const agent = async (name: string): Promise<AgentId> => {
    const agentId = id('agent');
    const ref = { id: id('deployment'), version: 1 };
    await store.addDeployment({
      agent: {
        id: agentId,
        name,
        provider: 'fake',
        activeDeployment: ref,
        latestDeployment: ref,
        account: null,
        createdAt: NOW,
      },
      deployment: {
        ...ref,
        agent: agentId,
        hash: 'a'.repeat(64),
        manifest: { protocol: 1, sdk: '0.15.0' },
        definition: {
          provider: 'fake',
          instructions: '',
          configuration: null,
          tools: [],
          inputs: [],
        },
        createdBy: BY,
        createdAt: NOW,
      },
      code: name,
    });
    return agentId;
  };
  const actor = async (of: AgentId): Promise<Actor> => {
    const one: Actor = {
      id: id('actor'),
      name: null,
      externalId: null,
      agent: of,
      deployment: { id: id('deployment'), version: 1 },
      pinned: false,
      behind: null,
      modelId: 'fake-1',
      reasoning: 'medium',
      configuration: null,
      machine: null,
      parent: null,
      status: 'idle',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: NOW,
      archivedAt: null,
    };
    await store.createActor(one);
    return one;
  };
  return { store, bytes, blobs, agent, actor };
}

describe('content that is kept', () => {
  it('has a reference in place of each image and file given as bytes, which are kept apart', async () => {
    const { blobs, bytes, agent, actor } = world();
    const one = await actor(await agent('orders'));
    const png = picture(1);
    const pdf = picture(2, 5000);
    const content: ContentPart[] = [
      { type: 'text', text: 'The receipt, and the contract.' },
      { ...image(png.data), providerOptions: { detail: 'high' } },
      {
        type: 'file',
        filename: 'contract.pdf',
        source: { type: 'base64', mediaType: 'application/pdf', data: pdf.data },
      },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ];
    const kept = await blobs.keep(one.id, content);
    expect(kept).toEqual([
      content[0],
      {
        type: 'image',
        source: { type: 'blob', digest: png.digest, mediaType: 'image/png', size: 300 },
        providerOptions: { detail: 'high' },
      },
      {
        type: 'file',
        filename: 'contract.pdf',
        source: { type: 'blob', digest: pdf.digest, mediaType: 'application/pdf', size: 5000 },
      },
      // What is somewhere else stays where it is.
      content[3],
    ]);
    expect(JSON.stringify(kept)).not.toContain(png.data);
    expect(await bytes?.get(png.digest)).toEqual(png.bytes);
    expect(await bytes?.get(pdf.digest)).toEqual(pdf.bytes);
  });

  it('is given back as it is when it has nothing to keep', async () => {
    const { blobs, agent, actor } = world();
    const one = await actor(await agent('orders'));
    const content: ContentPart[] = [
      { type: 'text', text: 'Hello.' },
      { type: 'image', source: { type: 'file_id', id: 'file-1' } },
    ];
    expect(await blobs.keep(one.id, content)).toBe(content);
  });

  it('keeps the same bytes once, whoever gives them and however often', async () => {
    const { blobs, bytes, agent, actor } = world();
    const orders = await agent('orders');
    const first = await actor(orders);
    const second = await actor(orders);
    const png = picture(1);
    await blobs.keep(first.id, [image(png.data), image(png.data)]);
    await blobs.keep(second.id, [image(png.data, 'image/webp')]);
    expect(await bytes?.list()).toEqual([png.digest]);
    // Each actor reads it back as it gave it.
    expect((await blobs.read(first.id, png.digest))?.blob.mediaType).toBe('image/png');
    expect((await blobs.read(second.id, png.digest))?.blob.mediaType).toBe('image/webp');
  });

  it('may name a blob its actor has, and no other: not another actor’s, and not one there is not', async () => {
    const { blobs, agent, actor } = world();
    const orders = await agent('orders');
    const first = await actor(orders);
    const second = await actor(orders);
    const png = picture(1);
    const [kept] = await blobs.keep(first.id, [image(png.data)]);
    // A tool gives back the image it was shown: said to be a size it is not, it is the size it is.
    const again = { type: 'image', source: { ...(kept as { source: object }).source, size: 9 } };
    expect(await blobs.keep(first.id, [again as ContentPart])).toEqual([kept]);

    const refused = blobs.keep(second.id, [kept as ContentPart]);
    await expect(refused).rejects.toBeInstanceOf(UnknownBlob);
    await expect(refused).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(refused).rejects.toThrow(png.digest);
    const none: ContentPart = {
      type: 'image',
      source: { type: 'blob', digest: 'f'.repeat(64), mediaType: 'image/png', size: 1 },
    };
    await expect(blobs.keep(first.id, [none])).rejects.toBeInstanceOf(UnknownBlob);
  });

  it('stays as it was given by an engine with no blob store, which takes no reference either', async () => {
    const { blobs, store, agent, actor } = world({ bytes: null });
    const one = await actor(await agent('orders'));
    const content = [image(picture(1).data)];
    expect(blobs.enabled).toBe(false);
    expect(await blobs.keep(one.id, content)).toBe(content);
    expect(await store.listBlobs()).toEqual([]);
    const named: ContentPart = {
      type: 'image',
      source: { type: 'blob', digest: 'f'.repeat(64), mediaType: 'image/png', size: 1 },
    };
    await expect(blobs.keep(one.id, [named])).rejects.toBeInstanceOf(UnknownBlob);
  });
});

describe('messages a model is sent', () => {
  it('have the bytes of every blob back in its place, and are otherwise as they were', async () => {
    const { blobs, agent, actor } = world();
    const one = await actor(await agent('orders'));
    const png = picture(1);
    const pdf = picture(2);
    const given: ContentPart[] = [
      { type: 'text', text: 'Look.' },
      { ...image(png.data), metadata: { from: 'camera' } },
      { type: 'file', source: { type: 'base64', mediaType: 'application/pdf', data: pdf.data } },
    ];
    const kept = await blobs.keep(one.id, given);
    const answer: Message = {
      role: 'assistant',
      provider: 'fake',
      api: 'fake',
      model: 'fake-1',
      content: [{ type: 'text', text: 'I see it.' }],
    };
    const plain: Message = { role: 'user', content: [{ type: 'text', text: 'And?' }] };
    const messages: Message[] = [
      { role: 'user', content: kept },
      answer,
      {
        role: 'tool_result',
        toolCallId: 'c1',
        toolName: 'camera',
        content: [kept[1] as ContentPart],
      },
      plain,
    ];
    const filled = await blobs.withBytes(messages);
    expect(filled).toEqual([
      { role: 'user', content: given },
      answer,
      { role: 'tool_result', toolCallId: 'c1', toolName: 'camera', content: [given[1]] },
      plain,
    ]);
    // What has no blob is the message it was, not a copy.
    expect(filled[1]).toBe(answer);
    expect(filled[3]).toBe(plain);
    // What is kept is not changed by being filled.
    expect(JSON.stringify(messages)).not.toContain(png.data);
  });

  it('read each blob once for a call, however often the conversation names it', async () => {
    const inner = new MemoryBlobStore();
    const reads: string[] = [];
    const counting: BlobStore = {
      put: (digest, bytes) => inner.put(digest, bytes),
      get: (digest) => {
        reads.push(digest);
        return inner.get(digest);
      },
      remove: (digest) => inner.remove(digest),
      list: () => inner.list(),
    };
    const { blobs, agent, actor } = world({ bytes: counting });
    const one = await actor(await agent('orders'));
    const png = picture(1);
    const kept = await blobs.keep(one.id, [image(png.data)]);
    const message: Message = { role: 'user', content: kept };
    await blobs.withBytes([message, message, message]);
    expect(reads).toEqual([png.digest]);
  });

  it('cannot be made when the bytes of a blob are gone: nothing is sent in their place', async () => {
    const { blobs, bytes, agent, actor } = world();
    const one = await actor(await agent('orders'));
    const png = picture(1);
    const kept = await blobs.keep(one.id, [image(png.data)]);
    await bytes?.remove(png.digest);
    const filling = blobs.withBytes([{ role: 'user', content: kept }]);
    await expect(filling).rejects.toBeInstanceOf(BlobMissing);
    await expect(filling).rejects.toThrow(
      `The bytes of the blob ${png.digest} are not in the blob store`,
    );
    await expect(blobs.read(one.id, png.digest)).rejects.toBeInstanceOf(BlobMissing);
  });
});

describe('a blob', () => {
  it('is read by an actor that refers to it, and is not there for any other', async () => {
    const { blobs, agent, actor } = world();
    const orders = await agent('orders');
    const first = await actor(orders);
    const second = await actor(orders);
    const png = picture(1);
    await blobs.keep(first.id, [image(png.data)]);
    expect(await blobs.read(first.id, png.digest)).toEqual({
      blob: { digest: png.digest, size: 300, mediaType: 'image/png', createdAt: NOW },
      bytes: png.bytes,
    });
    expect(await blobs.read(second.id, png.digest)).toBeUndefined();
    expect(await blobs.read(first.id, 'f'.repeat(64))).toBeUndefined();
  });

  it('is removed when the last actor that referred to it is gone, and not before', async () => {
    const { blobs, bytes, store, agent, actor } = world();
    const orders = await agent('orders');
    const billing = await agent('billing');
    const first = await actor(orders);
    const second = await actor(billing);
    const own = picture(1);
    const shared = picture(2);
    await blobs.keep(first.id, [image(own.data), image(shared.data)]);
    await blobs.keep(second.id, [image(shared.data)]);
    expect(await blobs.collect()).toBe(0);

    await store.deleteAgent(orders);
    expect(await blobs.collect()).toBe(1);
    expect(await bytes?.list()).toEqual([shared.digest]);
    expect((await blobs.read(second.id, shared.digest))?.bytes).toEqual(shared.bytes);

    await store.deleteAgent(billing);
    expect(await blobs.collect()).toBe(1);
    expect(await bytes?.list()).toEqual([]);
    expect(await store.listBlobs()).toEqual([]);
  });

  it('that is being removed is not lost to one who keeps the same bytes at that moment', async () => {
    // Removing takes a while here: the bytes go a moment after the store forgot the blob.
    const inner = new MemoryBlobStore();
    const slow: BlobStore = {
      put: (digest, bytes) => inner.put(digest, bytes),
      get: (digest) => inner.get(digest),
      remove: async (digest) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await inner.remove(digest);
      },
      list: () => inner.list(),
    };
    const { blobs, store, agent, actor } = world({ bytes: slow });
    const orders = await agent('orders');
    const billing = await agent('billing');
    const first = await actor(orders);
    const second = await actor(billing);
    const png = picture(1);
    await blobs.keep(first.id, [image(png.data)]);
    await store.deleteAgent(orders);

    const [, kept] = await Promise.all([blobs.collect(), blobs.keep(second.id, [image(png.data)])]);
    expect((await blobs.read(second.id, png.digest))?.bytes).toEqual(png.bytes);
    expect(await blobs.withBytes([{ role: 'user', content: kept }])).toEqual([
      { role: 'user', content: [image(png.data)] },
    ]);
  });
});

describe('when an engine starts, the blob store', () => {
  it('loses the bytes nothing was told of, and the blobs nothing refers to, and keeps the rest', async () => {
    const { blobs, bytes, store, agent, actor } = world();
    const orders = await agent('orders');
    const billing = await agent('billing');
    const first = await actor(orders);
    const second = await actor(billing);
    const gone = picture(1);
    const kept = picture(2);
    // What a process wrote, and died before it said so.
    const orphan = picture(3);
    await blobs.keep(first.id, [image(gone.data)]);
    await blobs.keep(second.id, [image(kept.data)]);
    await bytes?.put(orphan.digest, orphan.bytes);
    // An agent was deleted, and the process died before its blobs were removed.
    await store.deleteAgent(orders);

    expect(await blobs.sweep()).toBe(2);
    expect(await bytes?.list()).toEqual([kept.digest]);
    expect(await store.listBlobs()).toEqual([kept.digest]);
    expect(await blobs.sweep()).toBe(0);
    expect(await new Blobs({ store }).sweep()).toBe(0);
  });
});
