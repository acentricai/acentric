# Changelog

What changed in each version, for the people who run a server. What a version promises is in
[VERSIONS.md](VERSIONS.md).

## 0.15.0

The first release of the rewritten engine. It has nothing in common with the npm packages of
the same names up to 0.14, which belong to an earlier project: nothing of this one is
published to npm.

- **Agents and actors.** Agents are written with the SDK that `acentric init` puts in a
  project, deployed with `acentric deploy`, and run in workerd isolates outside the server.
  An actor's turns are kept as they go, and go on where they were after a restart.
- **Models.** OpenAI, Anthropic and Fireworks, with model accounts by API key, usage and cost
  of every call, and compaction that each provider does natively.
- **What actors do.** Tools, scripts (code mode), MCP servers, subagents, schedules, and
  commands on machines.
- **Machines.** The machine program, installed from the server with one command, connects
  out to it and is updated from it. Sandboxes are made at Docker (for testing) and Boat.
- **People.** Sign-in with email and password, roles, invites and password-reset links by
  link, API keys, sessions, and an audit log.
- **The dashboard**, served by the server: agents, actors and their conversations, machines
  and sandboxes, model accounts and usage, API keys, people, the audit log, and your account.
- **The images**, `ghcr.io/acentricai/acentric-server` and `ghcr.io/acentricai/acentric-sandbox`,
  for linux/amd64 and linux/arm64, signed.
