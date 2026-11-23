// What the dashboard's page is sent with: it may call only the server it came from, may not be
// framed, and runs only its own files. The server sends these on every file of the dashboard
// (apps/server/src/dashboard.ts); the development server sends them too, so that anything they
// forbid shows while the dashboard is worked on.

/** The policy. In development Vite adds its styles in `<style>` tags with a nonce, and reloads over a socket. */
export function contentSecurityPolicy(
  dev: { readonly nonce: string; readonly hmr: string } | null = null,
): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    dev === null ? "style-src 'self'" : `style-src 'self' 'nonce-${dev.nonce}'`,
    "font-src 'self'",
    "img-src 'self' data:",
    dev === null ? "connect-src 'self'" : `connect-src 'self' ${dev.hmr}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(policy: string): Record<string, string> {
  return {
    'Content-Security-Policy': policy,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
