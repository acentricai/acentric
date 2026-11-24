# Settings

Everything a server is set up with is a variable of its environment. Whatever is wrong with
one is said as it starts, and it does not start: a server does not run with half of what it
was told. The recipes in [deploy/](deploy/) set what they need; what is not set has the value
under "Without it".

The image sets five of them for itself: `ACENTRIC_HOST=0.0.0.0`, `ACENTRIC_PORT=4000`,
`ACENTRIC_DATA=/data`, `ACENTRIC_DASHBOARD` and `ACENTRIC_DOWNLOADS`. Leave the last two as the
image has them.

## The server

| Setting               | Without it                  | What it is                                                                                                                                                                  |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACENTRIC_PUBLIC_URL` | where it listens            | Where people reach the server, such as `https://engine.example.com`: what the links it makes, and the scripts that install the command and the machine program, start with. |
| `ACENTRIC_PORT`       | 4000                        | The port of its API and dashboard. 0 takes any free one.                                                                                                                    |
| `ACENTRIC_HOST`       | 127.0.0.1                   | The address it listens on: 127.0.0.1 is this machine alone, 0.0.0.0 every address it has.                                                                                   |
| `ACENTRIC_DATA`       | `./data`                    | The folder of its database, and of conversations' images and files (`blobs`). On a disk of the machine or a block volume: never a network file system.                      |
| `ACENTRIC_DASHBOARD`  | none: the image has its own | The folder of the dashboard's build, which the server serves at every path that is not the API's. Without it, the links the server makes have no page behind them.          |
| `ACENTRIC_DOWNLOADS`  | none: the image has its own | The folder of what the server hands out: the `acentric` command at `/install-cli.sh`, and the machine program at `/install.sh`.                                             |

## Keys

[SECRETS.md](SECRETS.md) says what each is, and how to change it. Each is read from a file as
well: `<name>_FILE` is the file's path, and what is in it is the value, without the line's end.
Give one or the other, not both. The recipes give files, which fewer can see than a process's
environment.

| Setting                    | Without it                                                  | What it is                                                                                                                     |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ACENTRIC_SECRET_KEY`      | the server keeps no secrets and no model accounts           | The key agents' secrets, model accounts' keys and actors' variables are sealed with: 32 bytes, as 64 hex characters or base64. |
| `ACENTRIC_SECRET_KEYS_OLD` | none                                                        | Keys it was before, separated by commas, so what they sealed still opens after it is changed.                                  |
| `ACENTRIC_ADMIN_KEY`       | a server with no key makes one, in `<data>/first-admin-key` | An API key that may do everything, of 24 characters or more: what other keys are made with.                                    |

## Turns and agents' code

| Setting                        | Without it | What it is                                                                                                                                              |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACENTRIC_MAX_TURNS`           | 1000       | How many actors are in a turn at once, from 1 to 10,000. The rest wait their turn, in order. [LIMITS.md](LIMITS.md) says what a machine takes.          |
| `ACENTRIC_CODE_PROCESSES`      | 2          | How many processes agents' code runs in, from 1 to 64. Each is replaced when it is past 1 GB.                                                           |
| `ACENTRIC_AGENT_NETWORK`       | `public`   | What agents' code may reach: `public`, public addresses alone, or `any`, which is this machine, its private network and a cloud's metadata address too. |
| `ACENTRIC_AGENT_NETWORK_ALLOW` | none       | With `public`: private addresses and ranges agents' code may reach as well, separated by commas, such as `10.0.0.0/8` or `10.1.2.3`.                    |

## Backups

[BACKUPS.md](BACKUPS.md) says what a backup is, and how one is put back.

| Setting                 | Without it             | What it is                                                                                                                                                                                                   |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACENTRIC_BACKUP_DIR`   | `<data>/backups`       | The folder its own backups go in. Without it they are on the disk of what they back up: another disk's is what survives losing that one.                                                                     |
| `ACENTRIC_BACKUP_EVERY` | 24h                    | How often it backs itself up, such as 6h, 30m or 7d (from 10 minutes to a year), as well as before a new version changes its database. `off` for neither.                                                    |
| `ACENTRIC_BACKUP_KEEP`  | 3                      | How many of its backups of each kind it keeps, in the folder and in the bucket.                                                                                                                              |
| `ACENTRIC_BACKUP_URL`   | none: the folder alone | A bucket each backup is copied to as well, such as `s3://my-bucket/acentric`: at S3, or at a store that speaks its API. Reached with AWS's own variables (`AWS_REGION`, `AWS_ENDPOINT_URL_S3`, credentials). |

## What is kept

[DATA.md](DATA.md) says what each removes. Each is a time such as 90d or 12h, from an hour to
36,500 days.

| Setting                    | Without it | What it is                                                                      |
| -------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `ACENTRIC_RETAIN_ARCHIVED` | for ever   | How long an archived actor is kept, with its subagents and their conversations. |
| `ACENTRIC_RETAIN_AUDIT`    | for ever   | How long the audit log keeps what was done.                                     |
| `ACENTRIC_RETAIN_USAGE`    | for ever   | How long what each call of a model used and cost is kept.                       |

## Logs and metrics

| Setting                 | Without it | What it is                                                                                                                            |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ACENTRIC_LOG_FORMAT`   | `text`     | `text`, a line for a person to read, or `json`, an object to a line, for what collects it.                                            |
| `ACENTRIC_LOG_LEVEL`    | `info`     | The least it writes: `debug`, `info`, `warn` or `error`.                                                                              |
| `ACENTRIC_METRICS_PORT` | none       | A port of its own, on `ACENTRIC_HOST`, that Prometheus' metrics are served at, at `/metrics`. Not the API's port, which people reach. |

## Sandboxes

Machines the server makes itself, at a provider ([README.md](README.md#running-the-server)).

| Setting                      | Without it                                                         | What it is                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACENTRIC_BOAT_TEMPLATE`     | an account at Boat is added, and no sandbox made                   | The Boat snapshot sandboxes are made from, with the machine program in it: `deploy/sandbox/boat-template.sh` builds it and prints its name.                                       |
| `ACENTRIC_BOAT_API_URL`      | `https://boat.dev/api/v1`                                          | Boat's API somewhere else. For tests.                                                                                                                                             |
| `ACENTRIC_DOCKER_HOST`       | none made at Docker                                                | Where Docker's API is, such as `unix:///var/run/docker.sock`: sandboxes are made there as containers. Whoever may make a sandbox then has the computer Docker is on. For testing. |
| `ACENTRIC_DOCKER_IMAGE`      | none: needed with `ACENTRIC_DOCKER_HOST`                           | The image sandboxes at Docker are made from: `ghcr.io/acentricai/acentric-sandbox` of the server's version.                                                                       |
| `ACENTRIC_DOCKER_NETWORK`    | Docker's own                                                       | The Docker network a sandbox is attached to.                                                                                                                                      |
| `ACENTRIC_DOCKER_SERVER_URL` | `ACENTRIC_PUBLIC_URL`, with `host.docker.internal` for `localhost` | Where a sandbox at Docker reaches the server, when that is not where people do.                                                                                                   |

## Not settings

- **Model providers' keys** are model accounts, added through the API (`acentric accounts
add`) and kept sealed. No key is read from the environment.
- **The recipes' own** variables, such as the Compose recipe's `ACENTRIC_VERSION`,
  `ACENTRIC_HTTP_PORT` and `ACENTRIC_HTTPS_PORT`, are read by the recipe, not the server.
