// A store that speaks as much of S3's API as backups use, by path, in memory: objects put
// whole and in parts, listed, read and removed. It checks no signature. Told to, it fails
// every request, as a bucket that cannot be reached does.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type FakeS3 = {
  readonly url: string;
  /** What is in it: `bucket/key` to its bytes. */
  readonly objects: Map<string, Buffer>;
  /** How many objects were put in parts. */
  readonly multipart: { count: number };
  /** Whether every request fails, with 503. */
  failing: boolean;
  close(): Promise<void>;
};

const body = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const xml = (response: ServerResponse, status: number, text: string): void => {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(`<?xml version="1.0" encoding="UTF-8"?>${text}`);
};

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function fakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const multipart = { count: 0 };
  const state = { failing: false };

  const server = createServer((request, response) => {
    void (async () => {
      if (state.failing) {
        xml(response, 503, '<Error><Code>ServiceUnavailable</Code><Message>Down</Message></Error>');
        return;
      }
      const url = new URL(request.url ?? '/', 'http://s3');
      const [bucket = '', ...rest] = url.pathname.slice(1).split('/');
      const key = rest.map((part) => decodeURIComponent(part)).join('/');
      const at = `${bucket}/${key}`;
      const query = url.searchParams;
      const method = request.method ?? 'GET';

      if (method === 'GET' && key === '') {
        const prefix = query.get('prefix') ?? '';
        const delimiter = query.get('delimiter');
        const keys = [...objects.keys()]
          .filter((name) => name.startsWith(`${bucket}/`))
          .map((name) => name.slice(bucket.length + 1))
          .filter((name) => name.startsWith(prefix))
          .filter((name) => delimiter === null || !name.slice(prefix.length).includes(delimiter))
          .toSorted();
        xml(
          response,
          200,
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${String(keys.length)}</KeyCount><IsTruncated>false</IsTruncated>${keys
            .map(
              (name) =>
                `<Contents><Key>${escape(name)}</Key><Size>${String(objects.get(`${bucket}/${name}`)?.length ?? 0)}</Size></Contents>`,
            )
            .join('')}</ListBucketResult>`,
        );
        return;
      }
      if (method === 'POST' && query.has('uploads')) {
        const id = randomUUID();
        uploads.set(id, new Map());
        xml(
          response,
          200,
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }
      const uploadId = query.get('uploadId');
      if (method === 'PUT' && uploadId !== null) {
        const parts = uploads.get(uploadId);
        if (parts === undefined) {
          xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        const number = Number(query.get('partNumber'));
        parts.set(number, await body(request));
        response.writeHead(200, { etag: `"part-${String(number)}"` });
        response.end();
        return;
      }
      if (method === 'POST' && uploadId !== null) {
        await body(request);
        const parts = uploads.get(uploadId);
        if (parts === undefined) {
          xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        uploads.delete(uploadId);
        objects.set(
          at,
          Buffer.concat(
            [...parts.entries()].toSorted(([a], [b]) => a - b).map(([, bytes]) => bytes),
          ),
        );
        multipart.count += 1;
        xml(
          response,
          200,
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><ETag>"whole"</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
      if (method === 'DELETE' && uploadId !== null) {
        uploads.delete(uploadId);
        response.writeHead(204);
        response.end();
        return;
      }
      if (method === 'PUT') {
        objects.set(at, await body(request));
        response.writeHead(200, { etag: '"whole"' });
        response.end();
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        const bytes = objects.get(at);
        if (bytes === undefined) {
          xml(
            response,
            404,
            `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${escape(key)}</Key></Error>`,
          );
          return;
        }
        response.writeHead(200, {
          'content-length': String(bytes.length),
          'content-type': 'application/x-tar',
        });
        response.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      if (method === 'DELETE') {
        objects.delete(at);
        response.writeHead(204);
        response.end();
        return;
      }
      xml(response, 400, '<Error><Code>NotImplemented</Code></Error>');
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    objects,
    multipart,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
