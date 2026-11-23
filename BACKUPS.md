# Backups

What a server keeps is in its folder of data (`ACENTRIC_DATA`, `/data` in its image): a SQLite
database, and the images and files of conversations beside it. Copying that folder while the
server runs can give a copy that does not open, so the server takes its backups itself, and its
program has the commands to take, check and put back one.

## The server's own

A server backs itself up:

- every `ACENTRIC_BACKUP_EVERY` (`24h` without it; `6h`, `30m`, `7d`…);
- before a new version changes its database, as it starts. If that backup fails, the database is
  not changed and the server does not start;
- when someone asks, with **Back up now** on the dashboard's Backups page, or `POST /v1/backups`.

Each goes in `ACENTRIC_BACKUP_DIR`, `<ACENTRIC_DATA>/backups` without it, as
`acentric-<time>-<kind>-<version>.tar`. The newest `ACENTRIC_BACKUP_KEEP` (3) of each kind are
kept. `ACENTRIC_BACKUP_EVERY=off` turns both kinds off. The Backups page, and `GET /v1/backups`,
say what became of the last one, and each backup taken or failed is in the audit log.

**Where they go is what they survive.** Beside the data, on its disk, they are there after a bad
upgrade or something removed by mistake, and lost with the disk. The recipes in
[deploy/](deploy/) give them a volume of their own. Copy them somewhere else as well: another
machine, or a bucket.

## The key

A backup never has `ACENTRIC_SECRET_KEY` in it. Its manifest says which keys sealed the agents'
secrets and the model accounts' keys in it, by ID. **Keep the key somewhere other than the server
and its backups**, such as a password manager. A backup put back without it has everything else,
and those do not open.

## The commands

The server's program, `acentric-server`, takes, checks and puts back a backup. Each runs in the
server's container, beside the server, and writes to stdout or reads from stdin without a file:

```sh
acentric-server backup [file]          # with the server running: a backup of this moment
acentric-server check-backup [file]    # reads one through, and says whether it is whole
acentric-server restore [file]         # with the server stopped: puts one back
```

- `backup` takes the database as it is at one moment, with SQLite's own online backup, while the
  server goes on.
- `check-backup` checks the database and each image and file against what the backup says they
  are, and whether this server has the keys it needs.
- `restore` reads and checks the whole backup before anything is changed. It refuses while a
  server runs on the data, and a backup of a newer version. What was in the folder is moved to
  `before-restore-<time>` in it, not removed. A backup whose keys this server was not given is
  refused, unless `--without-keys`, which puts back all else.

How each is run, for each recipe, is in its README: [compose](deploy/compose/),
[kubernetes](deploy/kubernetes/), [systemd](deploy/systemd/).

## Snapshots of the disk

A snapshot of the whole volume at one moment, as a cloud's block volume snapshot is, is a backup
too: SQLite reads it back as it does a server that stopped without warning. A copy of the files
one at a time is not.
