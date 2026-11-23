# Deploying Acentric

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

[sandbox](sandbox/) is not a way to run the server: it is what sandboxes at Docker and Boat are made from.

## What every one of them is careful of

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
- **The secrets key.** `ACENTRIC_SECRET_KEY` seals agents' secrets and the keys of model
  accounts. Make it once, and keep a copy somewhere other than the server: without it, what it
  sealed cannot be opened again. Each recipe gives it, and the admin key, as files the server
  reads (`ACENTRIC_SECRET_KEY_FILE`, `ACENTRIC_ADMIN_KEY_FILE`), not settings of its
  environment, which more can see. To change it: [SECRETS.md](../SECRETS.md).
- **Stopping.** The server is given a minute to stop, so that a turn that is going on is
  written down. Told to stop, `/health` says so for three seconds before it takes no more, for
  what is in front to send requests elsewhere.
- **Health.** `/health` answers 200 when the server takes requests, and 503 with why when it
  does not (its database does not answer, no process runs agents' code, it is upgrading or
  stopping): what sends it requests asks this. `/health/live` answers 200 while the process is
  there, upgrading too: what restarts it asks this.
- **Logs and metrics.** The server's log is text, or JSON with `ACENTRIC_LOG_FORMAT=json`: a
  line for each request and each turn, and for what failed, with no secret in any. With
  `ACENTRIC_METRICS_PORT` (9464 in the recipes), Prometheus' metrics are at `/metrics` on that
  port, never on the API's: requests, turns, calls of models (with tokens and cost), tool
  calls, daemons connected, the database's size, and when the newest backup was taken. Alert
  on that last one. Kubernetes' pod has them, with Prometheus' annotations; Compose's and
  systemd's say how to turn them on.
- **Backups.** The server backs itself up every day and before an upgrade, into a volume of
  the backups' own, and copies each to a bucket with `ACENTRIC_BACKUP_URL`: give it one. [BACKUPS.md](../BACKUPS.md) says how, and each
  recipe's README how a backup is taken and put back there.
- **What it keeps.** Everything is kept until it is deleted, or until `ACENTRIC_RETAIN_*` say
  how long: [DATA.md](../DATA.md).
- **Upgrading.** An exact version, changed on purpose: see [VERSIONS.md](../VERSIONS.md).
