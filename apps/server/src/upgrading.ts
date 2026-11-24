// While a new version backs up the database and then changes it, which takes a while on a large
// one, the server's port answers that it is upgrading: 503 to everything, but 200 at
// /health/live, which says the process is there. So what watches it (a Kubernetes probe, a load
// balancer) tells a server that is upgrading from one that died, and does not stop it in the
// middle, to start it again and back it up again. The dashboard's own files are served as ever,
// so that one who opens it then is told it is updating, by the dashboard, rather than shown an
// answer of the API.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { dashboardFiles } from './dashboard.ts';

/** The port, held until the server itself takes it. */
export type Holding = { close(): Promise<void> };

export async function holdPort(options: {
  readonly host: string;
  readonly port: number;
  /** The version being upgraded to. */
  readonly version: string;
  /** The folder of the dashboard's build. None, without it. */
  readonly dashboard?: string;
}): Promise<Holding> {
  const files = options.dashboard === undefined ? undefined : dashboardFiles(options.dashboard);
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const file = request.method === 'GET' ? files?.(path) : undefined;
    if (file !== undefined) {
      response.writeHead(200, file.headers);
      response.end(file.body);
      return;
    }
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(status === 503 ? { 'retry-after': '30' } : {}),
      });
      response.end(JSON.stringify(body));
    };
    if (path === '/health/live') {
      send(200, { ok: true, version: options.version, upgrading: true });
    } else if (path === '/health') {
      send(503, { ok: false, version: options.version, upgrading: true });
    } else {
      send(503, {
        error: {
          code: 'unavailable',
          message: `The server is upgrading its database to ${options.version}, and answers once it has`,
          requestId: randomBytes(8).toString('hex'),
        },
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
