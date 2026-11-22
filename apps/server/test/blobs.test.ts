// The images and files of conversations, through the API: named in messages, and read by
// their own route.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { says } from '@acentric/ai/testing';
import type { ActorId, ContentPart } from '@acentric/protocol';

import { ADMIN, api, refusal } from './api.ts';
import type { Api } from './api.ts';

const media = (fill: number, mediaType: string, type: 'image' | 'file' = 'image') => {
  const bytes = new Uint8Array(500).fill(fill);
  const data = Buffer.from(bytes).toString('base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    data,
    digest,
    given: { type, source: { type: 'base64', mediaType, data } } as ContentPart,
    kept: { type, source: { type: 'blob', digest, mediaType, size: 500 } },
  };
};
const png = media(1, 'image/png');
const pdf = media(2, 'application/pdf', 'file');
const page = media(3, 'text/html', 'file');

/** An actor of a new agent. */
async function actorOf({ admin, deploy }: Api, name = 'orders') {
  const { agent } = await deploy(name, name === 'orders' ? 'orders@1' : 'billing@1');
  const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
  return actor;
}

/** Sends an actor content, and waits until it has nothing left to do. */
async function show({ admin, engine }: Api, actor: ActorId, content: ContentPart[]) {
  await admin.call('inputs.send', {
    params: { actor },
    body: { type: 'message', payload: { content } },
  });
  await engine.settled(actor);
}

describe('an image or a file of a conversation', () => {
  it('is named in its message, and its bytes are read by their own route', async () => {
    const one = await api([says('A receipt.')]);
    const { admin, runner, failures } = one;
    const actor = await actorOf(one);
    await show(one, actor.id, [{ type: 'text', text: 'What is this?' }, png.given, pdf.given]);

    const { items } = await admin.call('messages.list', { params: { actor: actor.id } });
    expect(items[0]?.message).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'What is this?' }, png.kept, pdf.kept],
    });
    expect(JSON.stringify(items)).not.toContain(png.data);
    const inputs = await admin.call('inputs.list', { params: { actor: actor.id } });
    expect(JSON.stringify(inputs)).not.toContain(png.data);
    // The model was sent the bytes.
    expect(runner.steps[0]?.messages[0]).toMatchObject({
      content: [{ type: 'text', text: 'What is this?' }, png.given, pdf.given],
    });

    expect(await admin.blob(actor.id, png.digest)).toEqual({
      bytes: png.bytes,
      mediaType: 'image/png',
    });
    expect(await admin.blob(actor.id, pdf.digest)).toEqual({
      bytes: pdf.bytes,
      mediaType: 'application/pdf',
    });
    expect(failures).toEqual([]);
  });

  it('is answered so that nothing in it runs, and a browser keeps it for good', async () => {
    const one = await api([says('A page.')]);
    const actor = await actorOf(one);
    await show(one, actor.id, [png.given, page.given]);
    const get = (digest: string) =>
      one.app.request(`/v1/actors/${actor.id}/blobs/${digest}`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });

    const image = await get(png.digest);
    expect(image.status).toBe(200);
    expect(Object.fromEntries(image.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-length': '500',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${png.digest}"`,
    });
    // What an agent's code calls a page is saved, and never shown as one of the server's.
    const html = await get(page.digest);
    expect(Object.fromEntries(html.headers)).toMatchObject({
      'content-type': 'text/html',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    expect(new Uint8Array(await html.arrayBuffer())).toEqual(page.bytes);
  });

  it('is there for those who may read its actor, and for no one else', async () => {
    const one = await api([says('A receipt.'), says('Hello.')]);
    const { admin, keyed } = one;
    const first = await actorOf(one);
    const second = await actorOf(one, 'billing');
    await show(one, first.id, [png.given]);
    await show(one, second.id, [{ type: 'text', text: 'Hello?' }]);
    const notFound = { code: 'not_found', status: 404 };

    // Another actor has no blob of that name, though the engine has the bytes.
    expect(await refusal(admin.blob(second.id, png.digest))).toEqual(notFound);
    expect(await refusal(admin.blob(first.id, 'f'.repeat(64)))).toEqual(notFound);
    expect(await refusal(admin.blob(first.id, 'not-a-digest'))).toEqual({
      code: 'invalid_request',
      status: 400,
    });

    const ofFirst = await keyed({
      scope: { type: 'actor', actor: first.id },
      permissions: ['actors:read'],
    });
    expect((await ofFirst.client.blob(first.id, png.digest)).bytes).toEqual(png.bytes);
    const ofSecond = await keyed({
      scope: { type: 'actor', actor: second.id },
      permissions: ['actors:read'],
    });
    expect(await refusal(ofSecond.client.blob(first.id, png.digest))).toEqual(notFound);
    const sender = await keyed({ scope: { type: 'engine' }, permissions: ['actors:send'] });
    expect(await refusal(sender.client.blob(first.id, png.digest))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect(await refusal(one.as().blob(first.id, png.digest))).toEqual({
      code: 'unauthenticated',
      status: 401,
    });
  });

  it('is not shown to an actor by naming it: an input that names another’s blob is refused', async () => {
    const one = await api([says('A receipt.'), says('The same receipt.')]);
    const { admin, runner } = one;
    const first = await actorOf(one);
    const second = await actorOf(one, 'billing');
    await show(one, first.id, [png.given]);
    expect(
      await refusal(
        admin.call('inputs.send', {
          params: { actor: second.id },
          body: { type: 'message', payload: { content: [png.kept] } },
        }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
    expect((await admin.call('inputs.list', { params: { actor: second.id } })).items).toEqual([]);

    // An actor may be sent, again, what its own conversation has.
    await show(one, first.id, [png.kept as ContentPart]);
    expect(runner.steps[1]?.messages.at(-1)).toMatchObject({ content: [png.given] });
  });

  it('goes with the agent whose actors had it', async () => {
    const one = await api([says('A receipt.')]);
    const { admin, blobs } = one;
    const actor = await actorOf(one);
    await show(one, actor.id, [png.given]);
    expect(await blobs.list()).toEqual([png.digest]);
    await admin.call('agents.delete', { params: { agent: actor.agent } });
    expect(await blobs.list()).toEqual([]);
    expect(await refusal(admin.blob(actor.id, png.digest))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });

  it('stays in its message on a server with no blob store, which has no blob to read', async () => {
    const one = await api([says('A receipt.')], { blobs: false });
    const { admin } = one;
    const actor = await actorOf(one);
    await show(one, actor.id, [png.given]);
    const { items } = await admin.call('messages.list', { params: { actor: actor.id } });
    expect(items[0]?.message).toMatchObject({ content: [png.given] });
    expect(await refusal(admin.blob(actor.id, png.digest))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });
});
