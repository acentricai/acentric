# @acentric/llm

Calls LLM providers from an agent's handlers: Anthropic, OpenAI and Fireworks,
each used the way it is designed, directly or through the acentric gateway.
Its readers for replies, such as the tool calls a reply makes, are pure, so an
agent's step can use them too.

The pure entry is written; the client is not yet.

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

The names are exported as `PROVIDER_SECRETS` and `GATEWAY_SECRETS`, so the CLI
and runners pass the matching environment variables without naming providers
themselves. acentric-cloud sets the gateway's two for every release.
