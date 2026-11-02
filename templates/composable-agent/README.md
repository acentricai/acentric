# Composable agent template

> **Work in progress.** This template is not published, and not yet offered by
> `npm create acentric`. Its parts and their contracts may change.

A template for model-driven agents: the loop every such agent shares (call
the model, run the tool calls it makes, call it again), with the parts that
differ between agents plugged in.

| Part                               | Does                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| [`src/loop`](src/loop)             | the loop: what step does with every message in every phase   |
| [`src/model`](src/model)           | which model answers and how hard it thinks                   |
| [`src/prompt`](src/prompt)         | the instructions the model works from                        |
| [`src/tools`](src/tools)           | defining tools, running their calls and reporting the output |
| [`src/inputs`](src/inputs)         | what callers send, and when a message sent mid-turn is used  |
| [`src/compaction`](src/compaction) | summarizing long conversations to fit the context window     |
| [`src/retry`](src/retry)           | trying failed model calls again, waiting longer each time    |
| [`src/custom`](src/custom)         | the agent's own behaviour, beside the template's             |

[STEP.md](STEP.md) says what step does in every phase, and the contracts the
parts meet. Model calls go through [@acentric/llm](../../packages/llm); its
handlers need `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `FIREWORKS_API_KEY` for
the models used.

```bash
pnpm vitest run templates/composable-agent
```
