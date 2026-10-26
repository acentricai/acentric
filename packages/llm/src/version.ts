// This package's version. The client sends it to the gateway, so a gateway
// running an older copy can refuse a newer client's request plainly instead
// of failing on a shape it does not know. A test keeps it equal to
// package.json's version.

export const LLM_VERSION = '0.1.0';
