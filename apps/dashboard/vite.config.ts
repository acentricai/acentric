// The dashboard is served by the server, beside its API, from the folder this build makes
// (`dist`). In development Vite serves it, and passes the API's paths on to a server:
// `ACENTRIC_URL`, or one on this machine at the server's own port.
//
// The Host header is left as the browser sent it. The server takes a request that carries its
// session cookie only from a page of its own origin, and compares the two.

import { defineConfig } from 'vitest/config';

import { contentSecurityPolicy, securityHeaders } from './src/csp.ts';

const PORT = 5175;
const NONCE = 'dashboard-dev';

export default defineConfig(({ command }) => {
  const server = process.env['ACENTRIC_URL'] ?? 'http://127.0.0.1:4000';
  const api = { target: server, changeOrigin: false };
  return {
    ...(command === 'serve' ? { html: { cspNonce: NONCE } } : {}),
    oxc: { jsx: { runtime: 'automatic' } },
    server: {
      port: PORT,
      strictPort: true,
      headers: securityHeaders(
        contentSecurityPolicy({ nonce: NONCE, hmr: `ws://localhost:${String(PORT)}` }),
      ),
      proxy: { '/v1': api, '/health': api },
    },
    preview: {
      port: PORT + 1,
      strictPort: true,
      headers: securityHeaders(contentSecurityPolicy()),
      proxy: { '/v1': api, '/health': api },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      // Fonts and images stay files, which the policy's `'self'` covers.
      assetsInlineLimit: 0,
      rollupOptions: {
        // React's libraries mark modules "use client": a page that runs only in the browser has
        // nothing to keep of it.
        onwarn(warning, warn) {
          if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
        },
      },
    },
    test: {
      name: 'dashboard',
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
    },
  };
});
