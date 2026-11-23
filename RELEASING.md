# Releasing

A release is a version of every package and of the machine program, built as the server's and
the sandbox's images, pushed to GHCR, signed, and described in a GitHub release. Nothing is
published to npm. What each version promises is in [VERSIONS.md](VERSIONS.md).

## Making one

1. **The version.** Set it in every `package.json` and in `Cargo.toml`'s `[workspace.package]`,
   then run `cargo update -p acentric-machine` and `pnpm install`. `pnpm versions` says
   whether they are one.
2. **The notes.** Add a `## <version>` section at the top of `CHANGELOG.md`: what changed, in
   words for the people who run a server, and for a minor version what they must do.
3. **Merge it** to `main` through a pull request, and wait for CI to pass on `main`.
4. **Tag that commit**, and push the tag:

   ```sh
   git tag v0.15.0 <commit>
   git push origin v0.15.0
   ```

The release workflow (`.github/workflows/release.yml`) then:

1. checks that the tag is the version of every package and of the machine program, that the
   version has notes, and that the commit is on `main` with CI passed;
2. builds both images for linux/amd64 and linux/arm64, with an SBOM and provenance, and pushes
   them as `<version>`, `<major>.<minor>` and, for a version that is not a pre-release,
   `latest`;
3. signs each with cosign, by the workflow's identity at GitHub;
4. pulls the server's image for each system, checks its signature, starts it, and checks that
   it says its version and hands out the command and the machine program for every system;
5. makes the GitHub release with the version's notes, the images' digests and how to verify
   them. Before 1.0 it is marked a pre-release.

If a step fails, nothing after it happens. Fix it on `main`, delete the tag and push it again
on the fixed commit, or make the next patch version.

## Before the first release

- **Who may pull.** A package that a private repository's workflow pushes to GHCR is private
  too: only members of the organisation can pull it. To let anyone pull it, an organisation
  owner makes each package public, once, in its settings on GitHub (Packages, then the
  package, then Package settings, then Change visibility).
- **What signing makes public.** Cosign records each signature in Sigstore's public
  transparency log, with the identity that signed it: this repository's name and the release
  workflow's path and tag.

## Trying it without releasing

A pull request that changes the `Dockerfile`, the workflow, the sandbox's files or
`CHANGELOG.md` runs the same workflow without pushing: it builds both images for both systems
and starts the arm64 server. To build them locally:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --target server .
docker buildx build --platform linux/amd64,linux/arm64 --target sandbox .
```
