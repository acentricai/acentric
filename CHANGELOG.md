# Changelog

What changed in each version, for the people who run a server. What a version promises is in
[VERSIONS.md](VERSIONS.md).

## Unreleased

- **Upgrades, tested.** CI upgrades the last release's server to each commit of `main`, on
  data it filled, and goes back again; a release does it before anything is pushed. Every
  release leaves a backup of a server filled as people fill one, which each later version
  opens in its tests.
- **A server that is upgrading says so.** While a new version backs up and changes the
  database, its port answers 503 with why, and 200 at the new `/health/live`. The Kubernetes
  recipe's startup and liveness probes ask `/health/live`, so a long upgrade is not stopped
  and started again.
- **Keys from files.** `ACENTRIC_SECRET_KEY`, `ACENTRIC_SECRET_KEYS_OLD` and
  `ACENTRIC_ADMIN_KEY` are read from the file `<name>_FILE` names, too. Every recipe now gives
  the keys as files: **take the recipe of the version you run** (0.15.0's are at its tag).
- **The first key is not logged.** A server with no admin key writes the key it makes to
  `/data/first-admin-key`, for its user alone, in place of printing it.
- **Changing the secrets key.** `acentric-server reseal` seals everything again with the
  current key, and the server says, as it starts, what is still sealed with an old one
  ([SECRETS.md](SECRETS.md)).
- **Logs.** A line for each request (route, status, how long, whose), each turn that ended,
  and each call of a model that failed; what failed, with its context and stack. As text, or
  as JSON with `ACENTRIC_LOG_FORMAT=json`; `ACENTRIC_LOG_LEVEL` for more or less.
- **Metrics.** With `ACENTRIC_METRICS_PORT`, Prometheus' metrics at `/metrics` on a port of
  their own: requests, turns, calls of models with their tokens and cost, tool calls, actors
  working, daemons connected, the database's size, blobs, and the newest backup.
- **`/health` means it.** It answers 503 with why when the database does not answer, no
  process runs agents' code, or the server is stopping (for three seconds before it takes no
  more). Quiet connections are kept 65 seconds, past what is in front keeps them.
- **Deleting an actor.** An archived actor, with its subagents and their conversations, is
  deleted with `DELETE /v1/actors/{actor}`, `acentric actors delete <actor> --yes`, or the
  dashboard; what it cost stays in the usage.
- **Old data removed.** Expired sessions and links always; archived actors, the audit log
  and usage past `ACENTRIC_RETAIN_ARCHIVED`, `ACENTRIC_RETAIN_AUDIT` and
  `ACENTRIC_RETAIN_USAGE`, when they are set ([DATA.md](DATA.md)). A new database gives back to
  the disk what is removed; `acentric-server compact` has one made before do so.
- **Fixed:** deleting an agent left its actors' machine commands in the database.
- **Fixed:** the Kubernetes recipe's settings, replaced in its README's example, dropped
  `ACENTRIC_BACKUP_DIR`, so backups were on the data's volume: they are merged now.
- **Fixed:** a backup now names the key of actors' variables among the keys it needs; the
  Compose recipe's `.env.example` was missing from the repository; the AWS recipe's data
  volume was not formatted (its label was too long for XFS).

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
- **Backups.** The server backs itself up every day and before an upgrade, keeping the newest
  of each kind, and `acentric-server backup`, `check-backup` and `restore` take, check and put
  back one. Only one server runs on a folder of data at a time. With `ACENTRIC_BACKUP_URL`,
  each is copied to a bucket at S3, or at a store that speaks its API, and restored from it.
- **The dashboard**, served by the server: agents, actors and their conversations, machines
  and sandboxes, model accounts and usage, API keys, people, the audit log, and your account.
- **Deploy recipes**: Docker Compose with Caddy, Kubernetes, systemd (Docker or Podman), and
  Terraform for one EC2 instance on AWS, with its data on a volume of its own, snapshots of
  it, and its backups in S3.
- **The images**, `ghcr.io/acentricai/acentric-server` and `ghcr.io/acentricai/acentric-sandbox`,
  for linux/amd64 and linux/arm64, signed.
