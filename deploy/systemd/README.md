# systemd

The server as a systemd service, from its image: by Docker with `acentric.service`, or by
Podman 4.4 or newer with `acentric.container`, a Quadlet that systemd makes a service of. Either
listens on `127.0.0.1:4000` only, for a proxy on the same machine to end HTTPS in front of it.

## Running it

```sh
sudo install -d -m 700 /etc/acentric
sudo install -m 600 acentric.env.example /etc/acentric/acentric.env
# Fill it in: the address, and a secrets key from `openssl rand -hex 32`, a copy of which is
# kept somewhere other than this machine.
```

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

To put one back, with the service stopped:

```sh
sudo systemctl stop acentric
sudo docker run --rm -i --env-file /etc/acentric/acentric.env --volume acentric-data:/data \
  ghcr.io/acentricai/acentric-server:0.15.0 acentric-server restore < acentric-2026-11-23.tar
sudo systemctl start acentric
```

## Upgrading

Set the new version (`ACENTRIC_VERSION` in `/etc/acentric/acentric.env` for Docker, `Image=` in
`acentric.container` for Podman), and `sudo systemctl restart acentric`: the new version backs the
database up before it changes it.

## Tested

`test.sh` runs the server by each, and checks that it starts, that systemd starts it again
when it dies with what it kept, and that its container goes when it stops. CI runs it.
