# Docker Compose, behind Caddy

The server and [Caddy](https://caddyserver.com) on one machine with Docker. Caddy gets an HTTPS
certificate for the server's name from Let's Encrypt and renews it.

## What it needs

- A machine with Docker and its Compose plugin: 2 CPUs and 4 GB to start, and a disk for what
  the server keeps.
- A name, such as `engine.example.com`, that points at the machine, and ports 80 and 443 of it
  reachable from the internet, for the certificate.

## Running it

```sh
cp .env.example .env    # then put the name in it
install -d -m 700 secrets
openssl rand -hex 32 > secrets/secret-key    # keep a copy somewhere other than this machine
openssl rand -hex 24 > secrets/admin-key     # the API key that may do everything
docker compose up -d
```

The keys are files the server reads, not settings in its environment, which `docker inspect`
shows. `secrets/` is for this machine's user alone; its files are readable, as the server's
user in the container reads them. Then open `ACENTRIC_PUBLIC_URL`. `docker compose logs server` has the setup link that makes the
first person, the owner.

## What it is

- `server`, from the image of the version in `.env`, on no port of the machine: only Caddy
  reaches it. What it keeps is in the volume `acentric_data`.
- `caddy`, on ports 80 and 443, which starts once the server says it is up. Its certificates are
  in the volume `acentric_caddy-data`.

## Backups

The server backs itself up every day, and before an upgrade, into the volume `acentric_backups`
([BACKUPS.md](../../BACKUPS.md)). Have them copied off this machine as well: set
`ACENTRIC_BACKUP_URL` in `.env` to a bucket, with what reaches it beside it (`.env.example` has
them), and each is copied there too. Or copy one off yourself, for instance from a cron job:

```sh
docker compose exec -T server acentric-server backup > "acentric-$(date -u +%F).tar"
```

To put one back, with the server stopped:

```sh
docker compose stop server
docker compose run --rm --no-deps -T server acentric-server restore < acentric-2026-11-23.tar
docker compose up -d
```

One in the bucket is put back by its URL, in place of `< file`:
`… acentric-server restore s3://my-bucket/acentric/<name>.tar`. What was there is kept in
`/data/before-restore-<time>`.

## Upgrading

Set the new `ACENTRIC_VERSION` in `.env`, and `docker compose up -d`: the new version backs the
database up before it changes it. [VERSIONS.md](../../VERSIONS.md) says what a version promises.

## Other ports

Where 80 and 443 are taken, set `ACENTRIC_HTTP_PORT` and `ACENTRIC_HTTPS_PORT`, and put the HTTPS
port in `ACENTRIC_PUBLIC_URL` too. People then use that address: plain HTTP is sent to port 443.

## Tested

`test.sh` brings it up with Caddy's own certificate for `localhost`, and checks through Caddy
that HTTPS works and HTTP is sent to it, that the server is on no other port, that its scripts
have its address, that the command it hands out deploys an agent, that an actor's events come as
they happen, and that a machine's daemon enrols and stays connected through Caddy when it is told
Caddy's authority with `SSL_CERT_FILE`, and does not when it is not; that a backup is taken and
put back, and one copied to a bucket at a store that speaks S3's API (versitygw) and put back
from it. CI runs it.
