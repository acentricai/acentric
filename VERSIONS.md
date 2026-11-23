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

## Going back

Stop the server, put back the backup taken before the upgrade (`acentric-server restore`, see
[BACKUPS.md](BACKUPS.md)) with the version you had, and run that version. Going back without
that backup is not possible once the newer version has opened the database.
