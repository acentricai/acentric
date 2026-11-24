# Running a server

How to run an Acentric server whose data you keep: which recipe, what to have before it starts,
its first start, and what to do while it runs. Each part says what it needs here, and links to
the whole of it.

## 1. A recipe

Ways to run the server, each tested as it is here (in CI, but for the AWS one, which needs an
account and is tested by hand; CI checks it is well formed):

| Recipe                          | For                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| [compose](compose/)             | One machine with Docker, behind Caddy, which gets its HTTPS certificate. The quickest.   |
| [kubernetes](kubernetes/)       | A Kubernetes cluster: one server on a volume of its own, behind a Gateway or an Ingress. |
| [systemd](systemd/)             | A machine whose services systemd runs: the image by Docker, or by Podman as a Quadlet.   |
| [terraform/aws](terraform/aws/) | One EC2 instance, its data on a volume of its own, snapshots, and backups in S3.         |

**Use the recipe of the version you run.** These are the next release's, which may need what
an older server does not have: for 0.15.0, take them from its tag (`git checkout v0.15.0`, or
`?ref=v0.15.0`).

**A machine** of 2 vCPU and 4 GB takes about 1,000 actors in a turn at once, and a disk of
20 GB to start, with room for backups beside it. A server is not run as more than one: one that
outgrows its machine is given a larger one, or a faster disk ([LIMITS.md](../LIMITS.md)).

[sandbox](sandbox/) is not a way to run the server: it is what sandboxes at Docker and Boat are
made from.

## 2. Before it starts

- **A name, and HTTPS in front.** Such as `engine.example.com`, for `ACENTRIC_PUBLIC_URL`. The
  Compose and AWS recipes have Caddy get its certificate; Kubernetes and systemd use what you
  have in front (below).
- **The secrets key,** 32 random bytes (`openssl rand -hex 32`), and **the admin key**, an API key
  that may do everything (`openssl rand -hex 24`). Each recipe says where they go: files the
  server reads. Keep a copy of the secrets key somewhere other than the server: without it, the
  secrets in a backup do not open ([SECRETS.md](../SECRETS.md)).
- **A bucket for backups,** at S3 or a store that speaks its API, so that they are somewhere
  other than the server's disk: `ACENTRIC_BACKUP_URL`, and a key or role that may write there
  ([BACKUPS.md](../BACKUPS.md#a-bucket)). The AWS recipe makes its own.
- **The settings** the recipe does not set, if any: [SETTINGS.md](../SETTINGS.md) has every one.

## 3. Its first start

1. Start it as its recipe says. Its log has a **setup link**: whoever opens it first becomes
   the owner, with an email and a password. It works once, for a week.
2. The owner adds people from the dashboard's People page, by invite links: the server sends no
   email.
3. Install the `acentric` command from the server (`curl -fsSL <url>/install-cli.sh | sh`),
   `acentric login` with an API key, and add a model account
   (`acentric accounts add <provider> <name>`): the [README](../README.md#using-it) goes on from
   there.
4. Check its backups: the dashboard's Backups page says where they go and whether the bucket is
   reached. **Back up now** takes one.

With no admin key, a server makes one as it first starts and writes it to
`/data/first-admin-key`, for its user alone: copy it somewhere safe and remove the file.

## 4. While it runs

- **Watch it.** `/health` answers 200 when it takes requests, and 503 with why when it does
  not; `/health/live` answers 200 while its process is there. With `ACENTRIC_METRICS_PORT`
  (9464 in the recipes), Prometheus' metrics are at `/metrics` on that port. Alert on:
  - `/health` not 200 for more than a few minutes;
  - `acentric_backup_newest_timestamp_seconds` older than a day and a bit, or
    `acentric_backup_failures_total` going up;
  - the disk of `/data` or of the backups filling (`acentric_database_bytes` says how the
    database grows);
  - `acentric_turns_waiting` above 0 for long, at the server's limit ([LIMITS.md](../LIMITS.md#when-a-server-is-at-its-limit)).

  Its log is a line for each request and each turn, and for what failed, with no secret in any:
  text, or JSON with `ACENTRIC_LOG_FORMAT=json`.

- **Check a backup now and then,** by putting one back on a server of its own, or with
  `acentric-server check-backup`. Its recipe's README says how ([BACKUPS.md](../BACKUPS.md)).
- **Upgrade on purpose.** Run an exact version. Read each version's notes in
  [CHANGELOG.md](../CHANGELOG.md), which versions go to which at once, and what an upgrade looks
  like as it goes ([VERSIONS.md](../VERSIONS.md)); each recipe's README has an Upgrading section,
  with going back.
- **Decide what is kept.** Everything is kept until it is deleted, or until `ACENTRIC_RETAIN_*`
  say how long, and removed data stays in older backups ([DATA.md](../DATA.md)).
- **Change a key** when one may have been seen: [SECRETS.md](../SECRETS.md) says how, for each.

## What every recipe is careful of

- **One server, one disk.** The server keeps everything in `/data`: a SQLite database, and
  conversations' images and files beside it. Run one server, never two on the same data, on a
  disk of the machine it runs on or a block volume. Not on a network file system (NFS, EFS,
  Azure Files): SQLite is not safe on one.
- **HTTPS in front.** The server speaks HTTP. What is in front ends HTTPS, and
  `ACENTRIC_PUBLIC_URL` is its HTTPS address: the links the server makes, and the scripts that
  install the command and the machine program, start with it.
- **Connections that stay open.** Machines' daemons keep a WebSocket to the server, and actors'
  events are a stream. What is in front passes WebSockets, sends the stream as it comes rather
  than in pieces, and does not close either after a minute of quiet. A deployment's code is up
  to 40 MB, so it takes a request that size. The stream sends a line every 25 seconds, and the
  server keeps a quiet connection 65 seconds, for what in front closes them sooner (AWS' load
  balancers, Cloudflare, nginx at 60 seconds).
- **A certificate of your own authority.** Machines' daemons trust Mozilla's authorities, as
  browsers do, and on Linux the certificates the machine trusts (where an organisation's
  authority is installed, with `update-ca-certificates` or `update-ca-trust`). Elsewhere, or
  for an authority installed nowhere, set `SSL_CERT_FILE` to a file of its certificates where
  the daemon runs.
- **The keys as files.** Each recipe gives the secrets key and the admin key as files the server
  reads (`ACENTRIC_SECRET_KEY_FILE`, `ACENTRIC_ADMIN_KEY_FILE`), not settings of its
  environment, which more can see.
- **Backups off the data's disk.** The server backs itself up every day and before an upgrade,
  into a volume of the backups' own, and copies each to a bucket with `ACENTRIC_BACKUP_URL`.
- **Stopping.** The server is given a minute to stop, so that a turn that is going on is
  written down. Told to stop, `/health` says so for three seconds before it takes no more, for
  what is in front to send requests elsewhere.
- **Health.** What sends the server requests asks `/health`, and what restarts it asks
  `/health/live`, so that a server upgrading its database is waited for, not restarted.
- **Metrics on a port of their own,** never on the API's, which people reach. Kubernetes' pod
  has them, with Prometheus' annotations; Compose's and systemd's say how to turn them on.
