# @acentric/protocol

The protocol between applications and acentric runners: JSON-RPC 2.0, one
message per line on stdio or one per WebSocket frame. This package has the
message types and a small peer that speaks JSON-RPC in both directions. Use
[@acentric/client](../client) to talk to a runner; the design is in
[docs/local-runner.md](../../docs/local-runner.md#protocol).

| Direction    | Messages                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app → runner | `initialize`, `secrets/set`, `agents/deploy`, `agents/list`, `sessions/create`, `input`, `configure`, `upgrade`, `get`, `list`, `log`, `delete`, `subscribe`, `unsubscribe` |
| runner → app | notifications `log`, `view`, `status`, `emit` for subscriptions; `effect/run` requests and `effect/cancel` notifications for kinds the app provides                         |
| app → runner | `effect/emit` notifications while it runs an effect                                                                                                                         |

A rejection or a failed step is a normal result, an `Answer`. A JSON-RPC
error means the request itself was wrong; its `data.code` is an `ErrorCode`.

```ts
import type { RunnerMethods } from '@acentric/protocol';

type CreateResult = RunnerMethods['sessions/create']['result'];
```
