# systemd

The server as a systemd service, from its image: by Docker with `acentric.service`, or by
Podman 4.4 or newer with `acentric.container`, a Quadlet that systemd makes a service of. Either
listens on `127.0.0.1:4000` only, for a proxy on the same machine to end HTTPS in front of it.

## Running it

On the machine, this folder of the version you run, then the settings and the keys:

```sh
git clone --depth 1 --branch v0.16.0 https://github.com/acentricai/acentric.git
cd acentric/deploy/systemd
sudo install -d -m 700 /etc/acentric /etc/acentric/secrets
sudo install -m 600 acentric.env.example /etc/acentric/acentric.env   # then put the address in it
openssl rand -hex 32 | sudo tee /etc/acentric/secrets/secret-key > /dev/null   # keep a copy elsewhere
openssl rand -hex 24 | sudo tee /etc/acentric/secrets/admin-key > /dev/null    # the API key that may do everything
sudo chmod 644 /etc/acentric/secrets/*
```

The keys are files the server reads in its container, not settings of its environment, which
`docker inspect` shows. `/etc/acentric/secrets` is root's alone; its files are readable, as the
server's user in the container reads them. `acentric login` asks for the key in
`/etc/acentric/secrets/admin-key`.

By Docker:

```sh
sudo install -m 644 acentric.service /etc/systemd/system/
sudo systemctl enable --now acentric
```

By Podman, with the version set in `acentric.container`:

```sh
sudo install -m 644 acentric.container /etc/containers/systemd/
sudo systemctl daemon-reload && sudo systemctl start acentric
```

The setup link is in `journalctl -u acentric`. What the server keeps is in the volume
`acentric-data`.

## In front of it

[Caddy](https://caddyserver.com) on the same machine, with `Caddyfile` here and the server's
name in its first line, gets and renews the HTTPS certificate. Another proxy must pass
WebSockets, not buffer responses, leave quiet connections open for an hour, and take a request
of 40 MB.

## Backups

The server backs itself up every day, and before an upgrade, into the volume `acentric-backups`
([BACKUPS.md](../../BACKUPS.md)). A backup to copy elsewhere (`podman` for `docker` with the
Quadlet):

```sh
sudo docker exec acentric acentric-server backup > "acentric-$(date -u +%F).tar"
```

With `ACENTRIC_BACKUP_URL` and what reaches the bucket in `/etc/acentric/acentric.env`, each is
copied to a bucket as well ([BACKUPS.md](../../BACKUPS.md#a-bucket)), and one there is put back
by its `s3://` URL in place of `< file`.

To put one back, with the service stopped:

```sh
sudo systemctl stop acentric
sudo docker run --rm -i --env-file /etc/acentric/acentric.env --volume acentric-data:/data \
  --volume /etc/acentric/secrets/secret-key:/run/secrets/acentric/secret-key:ro \
  --volume /etc/acentric/secrets/admin-key:/run/secrets/acentric/admin-key:ro \
  ghcr.io/acentricai/acentric-server:0.16.0 acentric-server restore < acentric-2026-11-23.tar
sudo systemctl start acentric
```

## Upgrading

Read the new version's notes in [CHANGELOG.md](../../CHANGELOG.md), and which versions it goes
to at once ([VERSIONS.md](../../VERSIONS.md#from-which-version-to-which)). When its notes say
this recipe changed, install its files from its tag again, keeping `/etc/acentric`. Then set the
new version, `ACENTRIC_VERSION` in `/etc/acentric/acentric.env` for Docker, or `Image=` in
`acentric.container` for Podman (and `sudo systemctl daemon-reload`), and:

```sh
sudo docker pull ghcr.io/acentricai/acentric-server:<version>   # or podman
sudo systemctl restart acentric
sudo journalctl -u acentric -f
```

A version that changes the database backs it up first, then changes it: its log says each, and
the server answers 503 meanwhile. It is done at `acentric-server <version> listening`, when
`curl -s 127.0.0.1:4000/health` answers `"ok":true` with the new version. [What an upgrade
looks like](../../VERSIONS.md#what-an-upgrade-looks-like) says what it writes, and how long it
takes.

To go back, put back the backup it took before it changed the database, with the version you
had. Its name ends `-before-upgrade-<new version>.tar`, in `/backups`
(`sudo docker exec acentric ls /backups`). Stop the service, set the version back, and put it
back as above, with `--volume acentric-backups:/backups` and its path after `restore` in place
of `< file`, and the image of the version you had; then start the service.

## Tested

`test.sh` runs the server by each, and checks that it starts, that systemd starts it again
when it dies with what it kept, and that its container goes when it stops. CI runs it.
