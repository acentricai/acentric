# Changelog

What changed in each version, for the people who run a server. What a version promises is in
[VERSIONS.md](VERSIONS.md).

## 0.17.1

**Upgrading from 0.17.0:** take this version's image, or take it from the dashboard where an
updater runs; the database is not changed, and nothing is deployed again. Nothing that worked
changes in the API: what it adds, it adds beside what was.

- **Added:** `GET /v1/usage` adds up by `hour`, `failure`, `kind` and `version` as well, and
  with `split`, each group by another as well, such as each day by provider, in one request.
  `tz` makes days and hours those of a time zone, UTC without it. `failed` narrows to the calls
  that failed, or those that were answered. Totals say how long an answered call took, as
  `medianMs` and `p95Ms`.
- **Added:** `GET /v1/usage/calls` lists the calls of models a filter leaves, newest first, a
  page at a time, with `usage:read`. A key is told of what it reaches, as with `/v1/usage`.
- **Changed:** the dashboard's LLM Usage page is new: the totals of a range, spend, tokens or
  calls by day and by provider, in the viewer's own days, what each provider, model and actor
  with its subagents spent, where the tokens went, and what each agent spent.
- **Changed:** the dashboard's errors are toasts, over a dialog too, and say what the server
  found wrong with a request it refused, such as a name that is not one.
- **Changed:** the dashboard adds machines and sandboxes for every agent, and asks no longer
  which: which agents one is for is still the API's to say. Its pages for model accounts,
  machines and sandboxes have no Agents column, and its top bar no Go to field.

## 0.17.0

**Upgrading from 0.16.** Take this version's image. **The database changes**, for the backups'
settings and people's pictures: the new version backs it up first, then changes it, and its
port answers that it is updating meanwhile. Deployed agents, machines' daemons and the command
carry over: nothing is deployed again.

- **The dashboard's Account page and Engine pages are in Settings now**, the tab at the foot of
  the sidebar: their old addresses (`/account`, `/keys`, `/people`, `/backups`, `/audit`) are
  no more.
- **To take later versions from the dashboard**, with Compose: take this version's recipe
  (`compose.yaml`, `Caddyfile` and `updater.sh`, from the tag `v0.17.0`), keeping `.env` and
  `secrets/`, and set `COMPOSE_PROFILES=updater` in `.env`. Without it, nothing changes: a
  version is taken as before.
- **A new permission, `updates:manage`**, which owners and admins hold. A key made before holds
  it only when it is made again.

- **Changed:** while a new version upgrades the database, the dashboard's own files are served
  as ever, so that it opens and says it is updating. The API answers 503 then, as before.
- **Added:** the next version is taken from the dashboard where an updater runs beside the
  server: Compose's recipe has one, with `COMPOSE_PROFILES=updater`. It downloads the version's
  image, checks its signature, takes it now or at a time, and puts back the one before when the
  new one does not become healthy. `POST` and `DELETE /v1/updates/request` ask it, with the new
  permission `updates:manage`, which owners and admins hold. Caddy, in the Compose and systemd
  recipes, holds requests while the server restarts.
- **Added:** `GET /v1/updates` says the server's version and the versions after it, with their
  notes, as GitHub's releases say, and which to take next: a patch, or the next minor. The
  server asks every few hours while someone looks. `ACENTRIC_UPDATE_CHECK=off` asks nothing.
- **Added:** backups may be set through the API, `PUT /v1/backups/settings`: on or off, how
  often, how many are kept, and a bucket reached with an access key of its own, checked first
  and its secret kept sealed. Once set, they take the place of `ACENTRIC_BACKUP_EVERY`,
  `ACENTRIC_BACKUP_KEEP` and `ACENTRIC_BACKUP_URL`, without a restart. The database gains a
  table for them: a backup is taken before it is changed, as ever.
- **A picture of each person.** `PUT /v1/me/photo` gives the person signed in a picture of
  them (a PNG, JPEG or WebP of 2 MiB at most, known by its bytes), `DELETE /v1/me/photo` takes
  it away, and `GET /v1/users/{user}/photo` shows it to anyone signed in. A person's `photo`
  says which one there is. **The database changes**, for a table of the pictures: the new
  version backs it up first, as it does for any change of it.
- **Settings, in the dashboard.** A tab at the foot of the sidebar opens them in a dialog of
  their own, with what were the Account page and the Engine section's pages, which go:
  - **Account:** your picture, name, email and role, and where you are signed in, each signed
    out from its row. Your password is changed with a reset link, as an admin gives one.
  - **People:** the members, their roles and whether they can sign in, and Invite, which makes
    a link. Invites are no longer listed.
  - **API keys:** each key gets every permission its reach allows that you hold: one agent, one
    actor (from every actor), or the whole engine. A new key is shown once, to copy.
  - **Backups:** when the next is taken, where they are stored, Back up now, and the backups;
    turning them on or off, how often, how many, and a bucket, from the dashboard.
  - **Audit log:** narrowed by action, a page at a time, each event opened whole.
  - **Updates:** the version, whether there is a newer one, and each one's notes; where an
    updater runs, Download, then Update now or Schedule. While the server takes a version,
    every page says it is updating, and the dashboard opens at its home once it answers.

## 0.16.1

Fixes. **Upgrading from 0.16.0:** take this version's image; the database is not changed, and
nothing is deployed again. Two of the fixes change what a server does:

- Deleting an agent now deletes the subagents under its actors, of other agents too, as
  deleting an actor deletes those under it.
- A service's key made with a person's key is held to that person: it does no more than they
  may, and stops while they are disabled.

- **Fixed:** the dashboard's API keys page failed after the Agents page, in a new tab, and said
  the server could not be reached. It says so now only when it could not.
- **Fixed:** one who followed an actor's events and went could stop the actor answering: a
  listener that fails is its own failure now. A stream that catches up a long conversation
  reads the next part once the last is taken, not all of it into memory.
- **Fixed:** an agent's MCP servers were reached from the server past `ACENTRIC_AGENT_NETWORK`:
  this machine, its private network, a cloud's metadata address. They are reached as far as
  agents' code may reach now.
- **Fixed:** what a server holds in memory had no end: actors only read, the code of every
  deployment ever called, every email a sign-in failed with, and every SQL statement made. Each
  has a number now ([LIMITS.md](LIMITS.md)).
- **Fixed:** with `ACENTRIC_BACKUP_EVERY` past 24 days, the server took backups one after
  another. A backup now checks that the data's disk has room for the copy of the database it
  makes there, where only the backups' disk was checked.

- **Fixed:** a turn interrupted while an agent was spawned went on to make the rest of its
  answer's calls.
- **Fixed:** deleting an agent left the subagents of other agents under its actors, which then
  failed every turn that wrote to their parent. They go with it now.
- **Fixed:** a store closed with writes still to be stored failed them; every request's sign-in
  waited for the disk; `/health` said 200 when the database's reader had gone.
- **Fixed:** a file sent to a machine in chunks was read whole into memory before its size was
  checked.
- **Fixed:** a service's key made with a person's key kept all it held when the person was
  disabled or given a smaller role.
- **Fixed:** two accounts of a provider could both be its default.
- **Fixed:** tries at signing in all at once got past the five allowed, and failures were never
  forgotten: they are forgotten a day after the last.
- **Fixed:** a key of an agent that was deleted was answered 404 for the list of agents.
- **Fixed:** a machine's daemon taking an update answered nothing else until it was done, and
  could be given up meanwhile.

## 0.16.0

**Upgrading from 0.15.0.** The database, deployed agents, machines' daemons and the command
carry over; nothing is deployed again. Before you start the new version:

- **Take this version's recipe** (its tag, `v0.16.0`). Each gives the keys as files now: make
  the files from the values you have (`ACENTRIC_SECRET_KEY` and `ACENTRIC_ADMIN_KEY`), as its
  README says, and take them out of the environment. A server given both a key and its `_FILE`
  does not start.
- **Look at `ACENTRIC_MAX_TURNS`.** A server now takes 1,000 actors in a turn at once where it
  took 100. On a machine smaller than 2 vCPU and 4 GB, set it lower.
- **A new server's first key** is in `/data/first-admin-key`, not its log.

Then upgrade as the recipe's README says ([VERSIONS.md](VERSIONS.md#what-an-upgrade-looks-like)).

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
- **How many turns at once.** `ACENTRIC_MAX_TURNS` is how many actors are in a turn at once:
  1,000 without it, where it was 100 and not a setting. Measured, 100 held a server back at a
  tenth of what it could do, and a machine of 2 vCPU and 4 GB takes 1,000. [LIMITS.md](LIMITS.md) has what was measured, and how large a machine to
  run. The metrics say turns running and waiting, actors in memory, and the server's CPU.
- **Deleting an actor.** An archived actor, with its subagents and their conversations, is
  deleted with `DELETE /v1/actors/{actor}`, `acentric actors delete <actor> --yes`, or the
  dashboard; what it cost stays in the usage.
- **Old data removed.** Expired sessions and links always; archived actors, the audit log
  and usage past `ACENTRIC_RETAIN_ARCHIVED`, `ACENTRIC_RETAIN_AUDIT` and
  `ACENTRIC_RETAIN_USAGE`, when they are set ([DATA.md](DATA.md)). A new database gives back to
  the disk what is removed; `acentric-server compact` has one made before do so.
- **A guide to running a server.** [deploy/README.md](deploy/README.md) goes from which
  recipe, through what to have before it starts and its first start, to what to watch and do
  while it runs. [SETTINGS.md](SETTINGS.md) has every setting. [VERSIONS.md](VERSIONS.md) says
  which versions go to which at once and what an upgrade looks like as it goes, and each
  recipe has how to upgrade it and go back.
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
