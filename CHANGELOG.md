# Changelog

Every published package is released together, at the same version. This file
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
packages follow [Semantic Versioning](https://semver.org); before 1.0, a minor
version may change APIs.

## Unreleased

## 0.1.1 - 2026-11-02

### Changed

- The documentation moved from a website into Markdown in
  [`docs/`](docs/README.md), with a new getting-started guide. The runner
  specification is now [docs/reference/runner-spec.md](docs/reference/runner-spec.md).
- Each package's `homepage` points at its README on GitHub, and packages have
  npm keywords.
- The CLI, client and local runner READMEs use the starter template's `notes`
  agent in their examples.
- Dependencies updated within their ranges, including `ws` 8.22.1.

## 0.1.0 - 2026-10-26

The first release.

- `@acentric/types`: the types an agent is made of.
- `@acentric/testing`: tests for an agent's pure half and its handlers, with
  no runner.
- `@acentric/replay`: simulation, faithful and what-if replay, and journal
  digests.
- `@acentric/runner-memory` and `@acentric/runner-local`: two runners that
  pass every conformance scenario; the local runner keeps sessions in SQLite
  or plain files and runs handlers in child processes.
- `@acentric/protocol` and `@acentric/client`: the JSON-RPC protocol between
  applications and runners, over stdio or WebSocket, and a TypeScript client.
- `@acentric/cli`: `acentric dev`, `build`, `start`, and commands to inspect,
  drive, replay and fork sessions.
- `@acentric/llm`: calls Anthropic, OpenAI and Fireworks from handlers, with
  pure readers for replies.
- `@acentric/conformance`: the scenarios every runner must pass.
- `create-acentric`: `npm create acentric`, with the `minimal` template.
