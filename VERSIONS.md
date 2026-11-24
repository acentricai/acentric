# Versions

Acentric has one version for everything it is: the server's image, the sandbox image, and what
the server hands out — the `acentric` command, the machine program, and the agent SDK that
`acentric init` puts in a new project. They are released together, and what is installed from
an engine is always that engine's own version.

## What a version promises

A version is `major.minor.patch`.

- **Before 1.0**, which is now, Acentric is alpha. A minor release (0.15 to 0.16) may change
  what the API takes and answers, what agents' code is given, and how the server is set up.
  Its notes say what changed and what to do. A patch release (0.15.0 to 0.15.1) fixes, and
  changes nothing that worked.
- **From 1.0**, a minor release only adds, and only a major release removes or changes.

Only the newest minor version is fixed. There are no fixes for older ones before 1.0.

## Images

```sh
ghcr.io/acentricai/acentric-server:0.15.0    # this version, and never another
ghcr.io/acentricai/acentric-server:0.15      # the newest patch of 0.15
ghcr.io/acentricai/acentric-server:latest    # the newest release
```

The sandbox image, `ghcr.io/acentricai/acentric-sandbox`, has the same tags. Both are built for
linux/amd64 and linux/arm64.

Run an exact version, or a digest, and change it on purpose. `0.15` takes patches without
asking. Don't run `latest` on a server whose data you keep: a new minor version may need
something of you.

Each image is signed by this repository's release workflow, at its tag, with no key that
anyone keeps. Before running one:

```sh
cosign verify ghcr.io/acentricai/acentric-server:0.15.0 \
  --certificate-identity https://github.com/acentricai/acentric/.github/workflows/release.yml@refs/tags/v0.15.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Each also carries a list of what is in it (an SBOM) and a record of how it was built (its
provenance), which `docker buildx imagetools inspect` shows.

## What an upgrade carries over

- **The database** moves forward when the new version first starts, and cannot be moved back:
  an older server refuses a database a newer one has opened. So the new version backs it up
  first, before it changes it, into the backups' folder ([BACKUPS.md](BACKUPS.md)), and does not
  start if that fails.
- **Agents that were deployed** keep running. An engine runs the bundle protocol of its own
  version and of the version before it (`SUPPORTED_BUNDLE_PROTOCOLS`). When the protocol
  changes, the release notes say so, and agents are deployed again with the new command
  before the next minor version.
- **Machines** keep working after the server is upgraded: a daemon of the version before is
  understood. Each is updated to the server's own build from the dashboard (Update daemon). A
  daemon from before updates existed is installed again with the command the Machines page
  gives.
- **The `acentric` command** sees when its engine has another version, offers to take it, and
  `acentric update` takes it.

The server says when there is a newer version: `GET /v1/updates` lists those after it with their
notes, from GitHub's releases, and which to take next by the rules below
(`ACENTRIC_UPDATE_CHECK=off` asks nothing). Where an updater runs beside it, as Compose's recipe
has one, the dashboard downloads that version and takes it, now or at a time
([deploy/compose](deploy/compose/README.md#from-the-dashboard)).

## From which version to which

- **To a newer patch of the same minor** (0.15.0 to 0.15.2): always. Nothing else is done.
- **To the next minor** (0.15 to 0.16): all of the above carries over. Read its notes in
  [CHANGELOG.md](CHANGELOG.md) first: they say what to do before or after, when there is
  something.
- **Past a minor** (0.15 to 0.17): the database is moved forward any number of versions at
  once, as its changes are made in order. Agents that were deployed and machines' daemons are
  promised one version back, not two. So go a minor at a time, each started and answering
  before the next; or go at once, then deploy every agent again with the new command and update
  every machine's daemon. The notes of each version between say which of these it needs.
- **Back:** to the version upgraded from, with the backup taken before it ([Going
  back](#going-back)). An older server on a database a newer one changed refuses to start, and
  says so: it never opens it.

## What an upgrade looks like

A new version that does not change the database starts as any start does. One that does:

1. writes `upgrading the database to <version>: the server answers once it has`, and from then
   its port answers 503 to everything, saying it is upgrading (`/health` with
   `"upgrading": true`), but `/health/live`, which answers 200;
2. writes `this version changes the database: backing it up first, to <folder>`, takes the
   backup, and copies it to the bucket when there is one (`ACENTRIC_BACKUP_URL`);
3. changes the database, and writes `acentric-server <version> listening on <address>`. From
   then `/health` answers 200 with the new version, and it is done.

The backup is most of the time it takes: the database and every image and file, read and
written once. A database of 1 GB took 3 seconds on a laptop's disk; on a disk of 125 MB a second,
as EBS' gp3 is without more, about 15 to 20 seconds a GB, and the copy to the bucket after
that. Each version's notes say when its change of the database takes long itself.

When the backup fails, as when its disk is full, the database is not changed and the server does
not start: its log says why. Make room, and start it again; or start it with
`ACENTRIC_BACKUP_EVERY=off`, without the backup, if you have one of your own.

What restarts the server asks `/health/live`, and what sends it requests asks `/health` (as
[deploy/](deploy/)'s recipes do), so a long upgrade is waited for, and not stopped in the
middle to start again.

## Going back

Stop the server, put back the backup taken before the upgrade (`acentric-server restore`, see
[BACKUPS.md](BACKUPS.md)) with the version you had, and run that version. Going back without
that backup is not possible once the newer version has opened the database.
