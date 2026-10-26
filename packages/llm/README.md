# @acentric/llm

Calls LLM providers from an agent's handlers: Anthropic, OpenAI and Fireworks,
each used the way it is designed, directly or through the acentric gateway.
Its readers for replies, such as the tool calls a reply makes, are pure, so an
agent's step can use them too.

```ts
// handlers.ts
import { createLlm } from '@acentric/llm/client';

export default {
  llm: {
    mode: 'reissue',
    run: (ctx) =>
      createLlm(ctx).complete({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        messages: ctx.args.messages,
      }),
  },
};
```

## Two entries

| Import                 | For                        | May use                            |
| ---------------------- | -------------------------- | ---------------------------------- |
| `@acentric/llm`        | the pure half and handlers | ECMAScript only: no I/O            |
| `@acentric/llm/client` | handlers                   | `fetch`, and the handler's secrets |

## The pure entry

- **A conversation:** `UserMessage`, `SystemMessage`, `ToolResultMessage`,
  `AssistantMessage<P>` (the provider's output as it is, sent back unchanged),
  `NativeMessage<P>` (input only provider `P` takes, such as OpenAI's
  compaction trigger) and `CustomMessage` (the application's own, never sent).
- **A call:** `LlmRequest<P>`, with no credentials, and `LlmResponse<P>`, with
  the model that answered, the stop reason, usage and cost.
- **Each provider's own types:** its options, input and output items, and
  response fields, for Anthropic Messages and the Responses format of OpenAI
  and Fireworks.
- **Readers:** `outputText`, `refusals`, `reasoningSummary`, `toolCalls`,
  `pendingToolCalls`; and `toolResult(call, content)`, which answers a call
  with what its provider requires on the result.
- **Moving a conversation:** `convert(messages, { provider, model })` returns
  the conversation ready for another provider or model, and every change it
  made: reasoning bound to a model, provider items, citations, options on
  parts that only another provider reads, tool call IDs Anthropic would
  refuse. Messages already fit for the target come back unchanged.
- **Models:** `MODELS` and `findModel(provider, id)` give each model's context
  window, output limit, input types and prices, and `estimateCost(usage,
pricing)` what a call cost. A model not listed still works.
- **Failures:** the client throws `LlmError`, whose `toJSON()` is what a runner
  reports to step ([RUNNERS.md](../../RUNNERS.md#8-handlers)). In step,
  `llmFailure(outcome)` reads it back: its `kind`, whether it is `retryable`,
  and `retryAfterMs`.

Every type is the framework's `Json`, so a response can be a handler's result
and a message can be a log entry's body as they are.

```ts
import { llmFailure, pendingToolCalls } from '@acentric/llm';

// In step, when the model call's result arrives:
if ('ok' in message.outcome) {
  const calls = pendingToolCalls(message.outcome.ok.message);
} else {
  const failure = llmFailure(message.outcome);
  if (failure?.retryable) {
    // try again after failure.retryAfterMs, with a @timer
  }
}
```

## The client

`createLlm(ctx, options?)` takes a handler's context, or anything with its
`secrets` and `signal`, and returns `{ complete(request) }`:

- One call, one finished response: no streaming, and never retried. Whether
  to try again is the agent's decision, from `llmFailure(outcome)` in step.
- The handler's signal stops the call: a cancelled or aborted effect fails
  with `cancelled`, and a call past `timeoutMs` (15 minutes at most) with
  `timeout`.
- The application's `custom` messages are left out of what is sent.
- `options.credentials`, `options.gateway` (or `false` to call providers
  directly) and `options.fetch` override what the secrets say.

For a gateway, `callProvider(request, credentials)` makes one call to the
provider with credentials in hand, and `readCredentials` checks credentials a
caller sent. `GatewayRequest`, `GatewayFailure` and `GATEWAY_ROUTE` are the
gateway's wire format: the request as it is, with the caller's own
credentials if any; the response as it is; and `{ error: LlmFailure }` on
failure.

The client uses only `fetch` and the web platform, so it runs in handlers
built for `node` and for `fetch`.

## Keys and the gateway

The client reads everything from the handler's secrets, never from the
environment, so the same code runs on every runner:

1. With `ACENTRIC_LLM_URL` and `ACENTRIC_LLM_TOKEN` set, it calls the gateway
   at that address with that token.
2. Otherwise it calls the provider directly with its key: `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY` or `FIREWORKS_API_KEY`.
3. A provider key set alongside the gateway's travels as the call's
   credentials, so the gateway uses it instead of its own.

Options passed to the client override all of these. A secret that is not set
rejects with `SecretNotSet` on every runner ([RUNNERS.md](../../RUNNERS.md#8-handlers)),
which is how the client tells which are set.

The names are exported as `PROVIDER_SECRETS` and `GATEWAY_SECRETS`, and
`llmSecrets(env)` picks those that are set from an environment. `acentric dev`
and `acentric start` pass them to handlers on their own, from the environment
and `.env`; with the memory runner, pass `secrets: llmSecrets(process.env)`.
acentric-cloud sets the gateway's two for every release.
